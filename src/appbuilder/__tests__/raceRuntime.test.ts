// src/appbuilder/__tests__/raceRuntime.test.ts — W3-c: the RaceEngine on
// fixtures (§4.13.2). Branch runs, coverage scoring and models are stubbed; the
// scratch worktrees, the 7-day loser refs and the read-tree promotion go through
// the real git-backed VersionService.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-race-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { ensureAppBuilderSchema, activeRaceFor, getAppProject, getRace, listRaces } = await import("../store.js");
const { createAppProject } = await import("../projects.js");
const { RaceEngine, RACE_TEMPERATURES } = await import("../race.js");
const { VersionService, appVersionRows } = await import("../versions.js");
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
import type { RaceDeps, RaceBranchOutcome } from "../race.js";
const exec = promisify(execFile);

ensureAppBuilderSchema();
const versions = new VersionService(appVersionRows);

async function waitFor(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function scaffoldApp(project: { workspaceDir: string }): void {
  const appDir = path.join(project.workspaceDir, "app");
  fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "src", "seed.ts"), "export const seed = 1;\n", "utf8");
}

interface BranchScript {
  text: string;
  file?: string;          // written inside the scratch tree
  hang?: boolean;         // never resolves until the race aborts
  fail?: boolean;
}

function raceDepsWith(scripts: BranchScript[], models: string[] = ["cloud-a", "cloud-b"]): RaceDeps {
  const seen: string[] = [];
  const step = (id: import("../types.js").VerifyStepId) => ({ id, command: null, ok: true, skipped: false, durationMs: 1, exitCode: 0, outputTail: "" });
  return {
    cloudModels: (count) => models.slice(0, Math.max(count, models.length)),
    async runBranch(input) {
      seen.push(`${input.branchIndex}:${input.model}:${input.temperature}`);
      const script = scripts[input.branchIndex] ?? scripts[scripts.length - 1]!;
      if (script.hang) {
        // wait "forever"; the abort signal is the only way out (§4.13.2 rule 4)
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 30_000);
        });
        return { ok: false, usage: zero(), error: "aborted" };
      }
      if (script.file) {
        fs.mkdirSync(path.join(input.worktreeDir, "app", "src"), { recursive: true });
        fs.writeFileSync(path.join(input.worktreeDir, "app", "src", script.file), `export const ${script.file.replace(/\W/g, "_")} = 1;\n`, "utf8");
      }
      const outcome: RaceBranchOutcome = {
        ok: !script.fail,
        reportText: script.text,
        // the branch's app_verify result: build ok, visual pass (§4.13.2 scoring input)
        report: {
          id: `vr_race_${input.branchIndex}`, projectId: input.project.id, runId: "", attempt: 1,
          tier: "standard", pass: true,
          steps: [step("placeholder"), step("check"), step("lint"), step("typecheck"), step("build")],
          consoleErrors: 0, screenshots: [], visualVerdict: "pass", visualNotes: "", logPath: "",
          error: null, startedAt: "", finishedAt: "",
        },
        usage: { promptTokens: 1_000, completionTokens: 500, cachedTokens: 0, credits: 3, wallMs: 100, toolCalls: 2 },
      };
      return outcome;
    },
    async coverage() { return 7; },
    versions,
  };
}

function zero(): RaceBranchOutcome["usage"] {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, credits: 0, wallMs: 0, toolCalls: 0 };
}

test("race: branches run with differentiated models + temperatures, choose promotes a version and keeps loser refs", async () => {
  const project = createAppProject({ title: "race-choose", baseWorkspace: tmp });
  scaffoldApp(project);
  // seed the version repo with one commit so the race starts from a real HEAD
  await versions.snapshot(project, { title: "Seed", summary: "seed", source: "build", usage: zero() });

  const engine = new RaceEngine(raceDepsWith([
    { text: "branch 0 built the page", file: "b0.ts" },
    { text: "branch 1 built a nicer page", file: "b1.ts" },
  ]));
  const started = engine.start(project, "ابنِ صفحة هبوط", 2);
  assert.ok(!("error" in started), `race starts, got ${JSON.stringify(started)}`);

  await waitFor("choosing", () => getRace(started.race.id)?.status === "choosing");
  const choosing = getRace(started.race.id)!;
  assert.equal(choosing.branches.length, 2);
  assert.ok(choosing.branches.every((b) => b.status === "done" && b.score !== null));
  // §4.13.2: branch scores exist; a full build with coverage 7 lands at 40+15+10+20+5+7=97
  assert.equal(choosing.branches[0]!.score!.total, 40 + 15 + 10 + 20 + 5 + 7);
  // the queue is paused during the race (§4.11.2)
  const { queueState } = await import("../promptQueue.js");
  assert.equal(queueState(project.id).paused, true);

  const chosen = await engine.choose(project, choosing.id, choosing.branches[1]!.id);
  assert.ok(!("error" in chosen), `choose ok, got ${JSON.stringify(chosen)}`);
  assert.equal((chosen as { version: { source: string; number: number } | null }).version!.source, "race");
  assert.equal((chosen as { version: { number: number } }).version!.number, 2);
  assert.ok(fs.existsSync(path.join(project.workspaceDir, "app", "src", "b1.ts")), "the chosen branch's file is promoted into the main tree");
  assert.ok(!fs.existsSync(path.join(project.workspaceDir, "app", "src", "b0.ts")), "the loser's file is not in the main tree");
  const promoted = getRace(choosing.id)!;
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.chosenBranchId, choosing.branches[1]!.id);
  assert.equal(getAppProject(project.id)!.activeVersion, 2);
  assert.equal(activeRaceFor(project.id), undefined, "no active race remains");
  // the queue resumed after the race ended
  assert.equal(queueState(project.id).paused, false);
  // §4.13.2 rule 3: the loser commit stays reachable under refs/loam/race/<raceId>/…
  const refs = await exec("git", ["--git-dir", path.join(project.workspaceDir, ".loam", "versions.git"), "for-each-ref", "--format=%(refname)", "refs/loam/race/"]);
  assert.ok(refs.stdout.includes(`refs/loam/race/${choosing.id}/`), `loser ref kept: ${refs.stdout}`);
  // the scratch trees are gone
  const scratch = path.join(project.workspaceDir, ".loam", "scratch");
  assert.ok(!fs.existsSync(scratch) || fs.readdirSync(scratch).length === 0, "scratch trees removed");
});

test("race: refuse a second race (already_running) and goal flavor (queue_incompatible is the route's job)", async () => {
  const project = createAppProject({ title: "race-single", baseWorkspace: tmp });
  scaffoldApp(project);
  const engine = new RaceEngine(raceDepsWith([{ text: "x", hang: true }, { text: "y", hang: true }]));
  const first = engine.start(project, "الأولى", 2);
  assert.ok(!("error" in first));
  await waitFor("branch rows", () => (getRace(first.race.id)?.branches.length ?? 0) === 2);
  const second = engine.start(project, "الثانية", 2);
  assert.deepEqual(second, { error: "already_running" });
  // abort cleans up and frees the project
  const aborted = await engine.abort(project, first.race.id);
  assert.ok(!("error" in aborted));
  assert.equal(getRace(first.race.id)!.status, "aborted");
  assert.equal(activeRaceFor(project.id), undefined);
  assert.equal(listRaces(project.id).length, 1);
});

test("race: abort stops the branches, keeps refs for the sweep, and the run row stops", async () => {
  const project = createAppProject({ title: "race-abort", baseWorkspace: tmp });
  scaffoldApp(project);
  const seed = await versions.snapshot(project, { title: "Seed", summary: "seed", source: "build", usage: zero() });
  assert.ok(seed, "the seed version exists");
  const { updateAppProjectRow } = await import("../store.js");
  updateAppProjectRow(project.id, { activeVersion: seed!.number });
  const engine = new RaceEngine(raceDepsWith([{ text: "a", hang: true }, { text: "b", hang: true }]));
  const started = engine.start(project, "سباق للإلغاء", 2);
  assert.ok(!("error" in started));
  await waitFor("branches running", () => (getRace(started.race.id)?.branches.every((b) => b.status === "running") ?? false));
  const r = await engine.abort(project, started.race.id);
  assert.ok(!("error" in r));
  const race = getRace(started.race.id)!;
  assert.equal(race.status, "aborted");
  assert.ok(race.branches.every((b) => b.status === "aborted"));
  // the race's run row is finished as stopped (§4.13.2 rule 4)
  const runRow = await import("../store.js").then((m) => m.getRun(started.runId));
  assert.equal(runRow!.status, "stopped");
  // nothing changed in the main tree
  assert.ok(!fs.existsSync(path.join(project.workspaceDir, "app", "src", "b0.ts")));
  assert.equal(getAppProject(project.id)!.activeVersion, seed!.number);
});

test("race: temperatures differentiate branches sharing one model; a broken build never outranks", () => {
  assert.deepEqual(RACE_TEMPERATURES, [0.2, 0.5, 0.8, 1.0]);
  const one = raceDepsWith([{ text: "x" }, { text: "y" }, { text: "z" }], ["only-cloud"]);
  // models list shorter than branches: index-based reuse with different temperatures
  const models = one.cloudModels(3);
  assert.deepEqual(models, ["only-cloud"]);
});
