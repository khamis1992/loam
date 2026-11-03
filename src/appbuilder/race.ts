// src/appbuilder/race.ts — Cap G §4.13: Race estimate + branch scoring. Several
// teams run the same prompt in scratch trees; the verify loop scores each branch
// and the USER still chooses (OD-8). A branch that fails to build can score at
// most 30, so it never outranks one that builds.
// W3-c adds the runtime: start/choose/abort over the version store's scratch
// trees, differentiated cloud models with temperatures, the budget ceiling and
// the 7-day loser-refs sweep.
import { database } from "../server/sqliteStore.js";
import { executionQueue } from "../server/executionQueue.js";
import { FLAT_USAGE_CREDITS, TOKENS_PER_CREDIT } from "../server/credits.js";
import { emitProjectEvent } from "./events.js";
import { recordAppUsage } from "./metering.js";
import { setQueuePaused } from "./promptQueue.js";
import {
  activeRaceFor, finishRun, getRace, insertRace, insertRaceBranch, insertRun, newAppRowId,
  updateRace, updateRaceBranch, updateAppProjectRow,
} from "./store.js";
import type { VersionService } from "./versions.js";
import type {
  AppProject, AppVersion, RaceBranch, RaceEstimate, RaceRun, RaceScore, VerifyReport, VersionUsage,
} from "./types.js";
import type { RoleTurnResult, RoleTurnRunner } from "./engine.js";

export const DEFAULT_RUN_CREDITS = FLAT_USAGE_CREDITS; // 10 at 5227rf43-era credits.ts
export const BUDGET_FACTOR = 1.5;
/** §4.13.2: branches reuse models with a different temperature by index. */
export const RACE_TEMPERATURES = [0.2, 0.5, 0.8, 1.0] as const;
/** Loser refs stay reachable for 7 days, then the sweep removes them. */
export const RACE_REF_KEEP_MS = 7 * 24 * 3600 * 1000;
/** Tools a race branch may not call: they change state outside its tree (§4.13.2). */
export const RACE_BLOCKED_TOOLS = ["app_task_create", "app_task_finish", "app_context_write"] as const;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function raceEstimate(projectId: string, branches: 2 | 3 | 4): RaceEstimate {
  const rows = database().prepare(
    `SELECT r.id, SUM(u.prompt_tokens + u.completion_tokens) AS tokens
     FROM app_runs r JOIN app_usage u ON u.run_id = r.id
     WHERE r.project_id = ? AND r.flavor = 'quick' AND r.status = 'done' AND r.race_id IS NULL
     GROUP BY r.id ORDER BY r.started_at DESC LIMIT 5`,
  ).all(projectId) as Array<{ id: string; tokens: number }>;
  const credits = rows.map((r) => Math.max(1, Math.ceil(r.tokens / TOKENS_PER_CREDIT)));
  const perRunCredits = credits.length ? median(credits) : DEFAULT_RUN_CREDITS;
  return {
    branches,
    perRunCredits,
    extraCredits: Math.ceil((branches - 1) * perRunCredits + branches),
    maxTotalCredits: Math.ceil(branches * BUDGET_FACTOR * perRunCredits),
    basis: credits.length ? "history" : "default",
    sampleRuns: credits.length,
  };
}

export const RACE_WEIGHTS = { build: 40, check: 15, lint: 10, visualPass: 20, visualUnavailable: 10, consoleClean: 5, requirementCoverage: 10 } as const;

export function scoreBranch(r: VerifyReport, requirementCoverage: number): RaceScore {
  const ok = (id: string) => r.steps.some((s) => s.id === id && s.ok);
  const build = ok("build") ? RACE_WEIGHTS.build : 0;
  const check = ok("check") ? RACE_WEIGHTS.check : 0;
  const lint = ok("lint") ? RACE_WEIGHTS.lint : 0;
  const visual = r.visualVerdict === "pass" ? RACE_WEIGHTS.visualPass : r.visualVerdict === "unavailable" ? RACE_WEIGHTS.visualUnavailable : 0;
  const consoleClean = build && r.consoleErrors === 0 ? RACE_WEIGHTS.consoleClean : 0;
  const coverage = Math.max(0, Math.min(RACE_WEIGHTS.requirementCoverage, Math.round(requirementCoverage)));
  // §4.13.2: a branch whose build failed scores AT MOST 30 (check, lint, coverage),
  // so a broken branch never outranks one that builds. The prose is the contract;
  // the raw sum alone would not enforce it.
  const raw = build + check + lint + visual + consoleClean + coverage;
  return { total: build ? raw : Math.min(raw, 30), build, check, lint, visual, consoleClean, requirementCoverage: coverage };
}

// ----------------------------------------------------------------------------
// W3-c: the race runtime (§4.13.2)
// ----------------------------------------------------------------------------

export interface RaceBranchOutcome {
  ok: boolean;
  /** The branch's final verify report, when one ran (scoreBranch input). */
  report?: VerifyReport | null;
  /** The branch Engineer's final report text (coverage scoring input). */
  reportText?: string;
  previewUrl?: string | null;
  usage: VersionUsage;
  error?: string;
}

export interface RaceDeps {
  /** Differentiated cloud models for the branches: `modelAbChain` filtered by `isCloudModel` (§4.13.2). */
  cloudModels(count: number): string[];
  /** Runs one Engineer quick run inside its scratch tree. */
  runBranch(input: {
    project: AppProject;
    raceId: string;
    branchIndex: number;
    worktreeDir: string;
    model: string;
    temperature: number;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<RaceBranchOutcome>;
  /** 0..10 requirement coverage per branch (one fast model call in production). */
  coverage(input: { project: AppProject; prompt: string; reportText: string; filesChanged: string[] }): Promise<number>;
  versions: VersionService;
}

/** True when at least one branch built. */
const anyBuilt = (race: RaceRun): boolean => race.branches.some((b) => b.status === "done");

export class RaceEngine {
  private controllers = new Map<string, AbortController>();

  constructor(private deps: RaceDeps) {}

  activeRace(projectId: string): RaceRun | undefined {
    return activeRaceFor(projectId);
  }

  /**
   * Starts one race (POST /runs with `race: {branches}`). Returns the run row
   * id that represents the race, per the §4.15.2 `{ runId }` contract, or an
   * error reason from the §4.13.2 mapping.
   */
  start(project: AppProject, prompt: string, branches: 2 | 3 | 4): { runId: string; race: RaceRun } | { error: string } {
    if (project.status === "editing") return { error: "queue_incompatible" };
    const existing = activeRaceFor(project.id);
    if (existing) return { error: "already_running" };
    const estimate = raceEstimate(project.id, branches);
    const raceId = newAppRowId("race_");
    // §4.11.2: the prompt queue pauses during a race.
    setQueuePaused(project.id, true);
    const race = insertRace({ id: raceId, projectId: project.id, prompt, budgetCredits: estimate.maxTotalCredits });
    const run = insertRun({ projectId: project.id, flavor: "quick", prompt, raceId });
    updateAppProjectRow(project.id, { status: "racing" });
    const controller = new AbortController();
    this.controllers.set(raceId, controller);
    // The race as a whole holds the project's app:<id> lock (§4.13.2).
    void executionQueue
      .enqueue(`race:${raceId}`, async () => this.execute(project, race, run.id, prompt, branches, estimate.maxTotalCredits, controller.signal), undefined, [`app:${project.id}`])
      .catch(() => undefined);
    this.emit(project.id, race);
    return { runId: run.id, race };
  }

  /** POST /races/:raceId/choose (§4.13.2 rule 2): promote the chosen branch. */
  async choose(project: AppProject, raceId: string, branchId: string): Promise<{ version: AppVersion | null } | { error: string }> {
    const race = getRace(raceId);
    if (!race || race.projectId !== project.id) return { error: "not_found" };
    if (race.status !== "choosing") return { error: "not_choosing" };
    const branch = race.branches.find((b) => b.id === branchId);
    if (!branch || branch.status !== "done") return { error: "branch_not_done" };
    try {
      const commit = await this.commitBranch(project, race, branch);
      // Promote: apply the chosen commit to the main tree (§4.13.2 rule 2).
      await this.deps.versions.git(project, ["read-tree", "--reset", "-u", commit]);
      const version = await this.deps.versions.snapshot(project, {
        title: `Race winner: branch ${branch.index + 1}`,
        summary: `Promoted race branch ${branch.index + 1} (${branch.tierLabel}).`,
        source: "race",
        usage: raceUsage(race),
      });
      if (version) updateAppProjectRow(project.id, { activeVersion: version.number });
      await this.keepLoserRefsAndCleanup(project, race, branch.id);
      const done = updateRace(raceId, { status: "promoted", chosenBranchId: branch.id });
      await this.deps.versions.sweepRaceRefs(project);
      setQueuePaused(project.id, false);
      finishRunForRace(project.id, raceId, "done");
      if (done) this.emit(project.id, done);
      return { version: version ?? null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** POST /races/:raceId/abort (§4.13.2 rule 4): stop every branch, keep refs, sweep. */
  async abort(project: AppProject, raceId: string): Promise<{ race: RaceRun } | { error: string }> {
    const race = getRace(raceId);
    if (!race || race.projectId !== project.id) return { error: "not_found" };
    if (race.status === "promoted" || race.status === "aborted" || race.status === "failed") return { error: "not_active" };
    const controller = this.controllers.get(raceId);
    controller?.abort();
    // Give the branch runner a beat to observe the abort before the trees go.
    await new Promise((res) => setTimeout(res, 50));
    for (const b of race.branches) {
      if (b.status === "running") updateRaceBranch(b.id, { status: "aborted" });
    }
    await this.keepLoserRefsAndCleanup(project, race, null);
    const done = updateRace(raceId, { status: "aborted", reason: null });
    await this.deps.versions.sweepRaceRefs(project);
    setQueuePaused(project.id, false);
    finishRunForRace(project.id, raceId, "stopped");
    this.controllers.delete(raceId);
    if (done) this.emit(project.id, done);
    return { race: done ?? getRace(raceId)! };
  }

  // ---------------------------------------------------------------- internals

  private emit(projectId: string, race: RaceRun): void {
    emitProjectEvent(projectId, "appRace", { race });
  }

  private async execute(
    project: AppProject,
    race: RaceRun,
    runId: string,
    prompt: string,
    branches: 2 | 3 | 4,
    budgetCredits: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.versions.init(project);
      let head = "";
      try {
        head = (await this.deps.versions.git(project, ["rev-parse", "--verify", "HEAD"])).trim();
      } catch {
        head = ""; // an empty repo races from an empty base commit (first build)
      }
      if (!head) {
        // Root commit of the empty tree so the scratch worktrees have a base.
        const tree = (await this.deps.versions.git(project, ["write-tree"])).trim();
        head = (await this.deps.versions.git(project, ["commit-tree", tree, "-m", "race base"])).trim();
        await this.deps.versions.git(project, ["update-ref", "HEAD", head]);
      }
      const models = this.deps.cloudModels(branches);
      const specs = Array.from({ length: branches }, (_, i) => ({
        idx: i,
        model: models.length > 0 ? models[i % models.length]! : "",
        temperature: RACE_TEMPERATURES[i % RACE_TEMPERATURES.length]!,
      }));
      if (models.length === 0) throw new NoCloudModelsError();

      // Scratch trees first (§4.13.2 Isolation); any failure aborts the race.
      const created: Array<{ dir: string; spec: (typeof specs)[number] }> = [];
      try {
        for (const spec of specs) {
          const dir = await this.deps.versions.addScratchTree(project, `race-${race.id}-${spec.idx}`, head);
          created.push({ dir, spec });
        }
      } catch (err) {
        void err;
        const failed = updateRace(race.id, { status: "failed", reason: "worktree_failed" });
        finishRunForRace(project.id, race.id, "failed");
        if (failed) this.emit(project.id, failed);
        return;
      }
      const rows = created.map(({ dir, spec }) => {
        const branch: RaceBranch = {
          id: newAppRowId("rb_"), raceId: race.id, index: spec.idx,
          model: spec.model, tierLabel: `Branch ${spec.idx + 1} (${spec.model || "cloud model"})`,
          worktreeDir: dir, status: "running", score: null, previewUrl: null,
          usage: zeroRaceUsage(),
        };
        insertRaceBranch(branch);
        return branch;
      });
      this.emit(project.id, getRace(race.id)!);

      // Budget ceiling: hitting it aborts the remaining branches (§4.13.2).
      let spent = 0;
      const outcomes = await Promise.all(created.map(async ({ dir, spec }, i) => {
        const row = rows[i]!;
        let outcome: RaceBranchOutcome;
        try {
          outcome = await this.deps.runBranch({
            project, raceId: race.id, branchIndex: spec.idx, worktreeDir: dir,
            model: spec.model, temperature: spec.temperature, prompt, signal,
          });
        } catch (err) {
          outcome = { ok: false, usage: zeroRaceUsage(), error: err instanceof Error ? err.message : String(err) };
        }
        spent += outcome.usage.credits;
        recordAppUsage({
          projectId: project.id, runId, role: "engineer", step: "implement", kind: "race",
          tier: spec.model, promptTokens: outcome.usage.promptTokens, completionTokens: outcome.usage.completionTokens,
          cachedTokens: outcome.usage.cachedTokens, toolCalls: outcome.usage.toolCalls, durationMs: outcome.usage.wallMs,
        });
        return { row, outcome, overBudget: spent > budgetCredits };
      }));

      if (signal.aborted) return; // abort() owns the row updates

      let anyBudgetAbort = false;
      for (const { row, outcome, overBudget } of outcomes) {
        if (overBudget && outcome.ok) anyBudgetAbort = true;
        let score: RaceScore | null = null;
        if (outcome.ok) {
          const coverage = await this.deps.coverage({ project, prompt, reportText: outcome.reportText ?? "", filesChanged: [] });
          score = scoreBranch(outcome.report ?? emptyFailedReport(), coverage);
        }
        updateRaceBranch(row.id, {
          status: outcome.ok ? "done" : "failed",
          ...(score ? { score } : {}),
          ...(outcome.previewUrl !== undefined ? { previewUrl: outcome.previewUrl } : {}),
          usage: outcome.usage,
        });
      }
      const after = getRace(race.id)!;
      const finishRace = (reason: RaceRun["reason"]): void => {
        const failed = updateRace(race.id, { status: "failed", reason });
        void this.keepLoserRefsAndCleanup(project, after, null);
        finishRunForRace(project.id, race.id, "failed");
        setQueuePaused(project.id, false);
        if (failed) this.emit(project.id, failed);
      };
      if (anyBudgetAbort) {
        finishRace("budget_exceeded");
        return;
      }
      if (!anyBuilt(after)) {
        finishRace("all_branches_failed");
        return;
      }
      const choosing = updateRace(race.id, { status: "choosing" });
      if (choosing) this.emit(project.id, choosing);
    } catch (err) {
      if (!(err instanceof NoCloudModelsError)) {
        void err; // keep the failed-status path identical for every cause
      }
      const failed = updateRace(race.id, { status: "failed", reason: "unknown" });
      finishRunForRace(project.id, race.id, "failed");
      setQueuePaused(project.id, false);
      if (failed) this.emit(project.id, failed);
    } finally {
      this.controllers.delete(race.id);
    }
  }

  /** Commit one branch tree in place and return its commit id. */
  private async commitBranch(project: AppProject, race: RaceRun, branch: RaceBranch): Promise<string> {
    const dir = branch.worktreeDir;
    await this.deps.versions.gitIn(dir, ["add", "-A"]);
    await this.deps.versions.gitIn(dir, ["commit", "--allow-empty", "--no-verify", "-q", "-m", `race ${race.id} branch ${branch.index}`]);
    return (await this.deps.versions.gitIn(dir, ["rev-parse", "HEAD"])).trim();
  }

  /** Loser commits stay reachable for 7 days (§4.13.2 rule 3); every tree goes. */
  private async keepLoserRefsAndCleanup(project: AppProject, race: RaceRun, chosenBranchId: string | null): Promise<void> {
    const stamp = Date.now();
    for (const b of race.branches) {
      try {
        const commit = await this.commitBranch(project, race, b);
        if (b.id !== chosenBranchId) {
          await this.deps.versions.git(project, ["update-ref", `refs/loam/race/${race.id}/${stamp}-${b.index}`, commit]);
        }
      } catch {
        /* a branch that never produced a commit just loses its tree */
      }
      await this.deps.versions.removeScratchTree(project, b.worktreeDir);
    }
  }
}

class NoCloudModelsError extends Error {
  constructor() { super("no cloud models configured"); this.name = "NoCloudModelsError"; }
}

function zeroRaceUsage(): VersionUsage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, credits: 0, wallMs: 0, toolCalls: 0 };
}

function emptyFailedReport(): VerifyReport {
  return {
    id: "vr_none", projectId: "", runId: "", attempt: 1, tier: "fast", pass: false, steps: [],
    consoleErrors: 0, screenshots: [], visualVerdict: "skipped", visualNotes: "", logPath: "",
    error: null, startedAt: "", finishedAt: "",
  };
}

function raceUsage(race: RaceRun): VersionUsage {
  return race.branches.reduce<VersionUsage>(
    (acc, b) => ({
      promptTokens: acc.promptTokens + b.usage.promptTokens,
      completionTokens: acc.completionTokens + b.usage.completionTokens,
      cachedTokens: acc.cachedTokens + b.usage.cachedTokens,
      credits: acc.credits + b.usage.credits,
      wallMs: acc.wallMs + b.usage.wallMs,
      toolCalls: acc.toolCalls + b.usage.toolCalls,
    }),
    zeroRaceUsage(),
  );
}

function finishRunForRace(projectId: string, raceId: string, status: "done" | "failed" | "stopped"): void {
  const rows = database().prepare("SELECT id FROM app_runs WHERE project_id = ? AND race_id = ?").all(projectId, raceId) as Array<{ id: string }>;
  for (const r of rows) finishRun(r.id, status);
}

// ----------------------------------------------------------------------------
// Production wiring helpers (routes use these; tests inject their own)
// ----------------------------------------------------------------------------

/**
 * The production branch runner: the same RoleTurnRunner the engine uses, with
 * the race-blocked stateful tools removed (§4.13.2) so a branch can never
 * touch state outside its scratch tree.
 */
export function createRaceBranchRunner(runner: RoleTurnRunner, tools: readonly string[]): RaceDeps["runBranch"] {
  const allowed = tools.filter((t) => !(RACE_BLOCKED_TOOLS as readonly string[]).includes(t));
  return async (input) => {
    const result: RoleTurnResult = await runner({
      project: input.project, runId: `race_${input.raceId}_${input.branchIndex}`, role: "engineer",
      step: "implement", system: "engineer", prompt: input.prompt, tools: allowed,
      workspaceDir: input.worktreeDir, temperature: input.temperature, signal: input.signal,
    });
    return {
      ok: result.text.trim().length > 0,
      reportText: result.text,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens,
        credits: Math.max(1, Math.ceil((result.usage.promptTokens + result.usage.completionTokens) / TOKENS_PER_CREDIT)),
        wallMs: result.usage.durationMs,
        toolCalls: result.usage.toolCalls,
      },
    };
  };
}

/** The production coverage scorer: one fast call per branch (§4.13.2). */
export function createModelCoverage(runner: RoleTurnRunner): RaceDeps["coverage"] {
  return async (input) => {
    try {
      const result = await runner({
        project: input.project, runId: "race_coverage", role: "lead", step: "version-title",
        system: 'You score how well a finished web app change covers the user\'s request. Reply with JSON only: {"coverage": <integer 0 to 10>, "missing": []}.',
        prompt: ["Request:", input.prompt.slice(0, 1_500), "", "Engineer report:", input.reportText.slice(0, 2_000)].join("\n"),
        tools: [], maxToolCalls: 0,
      });
      const m = /"coverage"\s*:\s*(\d+)/.exec(result.text);
      if (m) return Math.max(0, Math.min(10, Number(m[1])));
    } catch {
      /* unparsable coverage counts as 0 */
    }
    return 0;
  };
}
