// src/appbuilder/engine.ts — W3-c: the AppRunEngine (MISSING §4.2, §4.4, §4.6,
// §4.7, §4.11). One engine drives Build (quick) and Goal runs of App projects
// through the runModes phase order, with pause gates for the questions card and
// the plan approval, the verify loop bound into the run, VersionService
// snapshots, project events and per-role metering.
//
// Every model-driven turn goes through one injected RoleTurnRunner so the M2
// gate runs on fixtures: the default runner is runAgent through stepRouting's
// cloud-only model selection; tests inject a stub. NoCloudModelError aborts the
// run with a clear Arabic error (§4.12.2 cloud-only rule).
import fs from "node:fs";
import path from "node:path";
import type { Emit } from "../agent/events.js";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { ToolRegistry } from "../tools/registry.js";
import { CancelledError } from "../server/runControl.js";
import { executionQueue } from "../server/executionQueue.js";
import { extractJson } from "../agent/planner.js";
import { NoCloudModelError, modelForStep, type AppStep } from "./stepRouting.js";
import { shouldSkipPhase } from "./runModes.js";
import { APP_ROLES, applyRoleScopeGate } from "./roles.js";
import { ENGINEER_SYSTEM, LEAD_SYSTEM, ROLE_SYSTEM, VERSION_TITLE_SYSTEM, engineerBriefPreamble } from "./prompts.js";
import {
  runLeadClarify, runLeadPlan, createAssignmentForPlan, finishAssignmentForPlan, type LeadExecutor, type QuestionCardEmitter,
} from "./lead.js";
import {
  activeRaceFor, finishRun, getRun, insertRun, insertVerifyReport, latestPlanDraft, latestVerifyReportForRun,
  listAssignments, updateAppProjectRow, updateAssignment, updateRun,
} from "./store.js";
import { getAppProject } from "./projects.js";
import { emitProjectEvent } from "./events.js";
import { appUsage, recordAppUsage, versionUsageSummary } from "./metering.js";
import { enqueuePrompt, markQueueItemFailed, markQueueItemSent, queueState, setQueuePaused, takeNextQueued } from "./promptQueue.js";
import {
  clearAppBuild, resolveVerifyTier, setActiveAppBuild, takeAddedPackages, takeVersionNote,
  verificationSummaryLine, type VerifyRunner,
} from "./tools.js";
import { writeVerificationSummary } from "./contextFiles.js";
import { loadTemplate } from "./templates.js";
import { copyLockfileIntoProject, ensureDepsFolder } from "./depsCache.js";
import { VersionService, zeroUsage } from "./versions.js";
import type {
  AppProject, AppProjectStatus, AppRunFlavor, AppRoleId, AppTaskAssignment, AppVersion, PlanDraft, VerifyReport,
} from "./types.js";

// ----------------------------------------------------------------------------
// Injectable seams
// ----------------------------------------------------------------------------

export interface RoleTurnUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  toolCalls: number;
  durationMs: number;
}

export interface RoleTurnInput {
  project: AppProject;
  runId: string;
  role: AppRoleId;
  step: AppStep;
  system: string;
  prompt: string;
  /** Role tool filter (APP_ROLES[role].tools) — the real runner intersects the base registry. */
  tools: readonly string[];
  /** Work tree for this turn: the project workspace, or a race scratch tree. */
  workspaceDir?: string;
  maxToolCalls?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface RoleTurnResult {
  text: string;
  usage: RoleTurnUsage;
}

export type RoleTurnRunner = (input: RoleTurnInput) => Promise<RoleTurnResult>;

/** §4.7.3 naming: the version title comes from app_version_note or one fast call. */
export type VersionNamer = (input: { project: AppProject; prompt: string; engineerReport: string; versionNumber: number }) => Promise<{ title: string; summary: string }>;

export interface AppEngineDeps {
  /** Cloud-only step model resolver (stepRouting.modelForStep). Throws NoCloudModelError. */
  pickModel(project: AppProject, role: AppRoleId | "system", step: AppStep): { model: string; tier: string };
  /** One model-driven role turn. The default runs runAgent; tests inject a stub. */
  runRoleTurn: RoleTurnRunner;
  /** VerifyLoop bound to this run's dev-server/visual deps (tools.ts VerifyRunner). */
  verify: VerifyRunner;
  /** The version store for this engine. */
  versions: VersionService;
  /** Template scaffold into <workspace>/app when the app dir is empty (§4.3). */
  scaffold(project: AppProject): Promise<void>;
  /** Stops the fullstack API server before a database restore (§4.7.3). */
  stopAppServer(project: AppProject): Promise<void>;
  /** Names a version when the run left no app_version_note (§4.7.3). */
  nameVersion: VersionNamer;
}

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

/** The user pressed stop: gates reject with this so the parked run unwinds. */
export class RunStoppedError extends Error {
  constructor() { super("stopped by user"); this.name = "RunStoppedError"; }
}

/** The cloud-only rule failed: the run aborts with a clear Arabic error (§4.12.2). */
export const NO_CLOUD_MODEL_AR = "منشئ التطبيقات يحتاج نموذجًا سحابيًا (وليس نموذجًا محليًا). اضبط نموذجًا سحابيًا من الإعدادات ← النماذج ثم أعد المحاولة.";

/** Max plan revisions one Goal run may cycle through before stopping cleanly. */
export const MAX_PLAN_REVISIONS = 5;

// ----------------------------------------------------------------------------
// Pause gates (§4.2.1 questions, §4.2.2 approval): the run parks on a promise
// that the HTTP route resolves. One gate per project at a time (the
// executionQueue lock means one active run per project).
// ----------------------------------------------------------------------------

export type PlanGateResolution =
  | { kind: "plan"; decision: "approve"; draft: PlanDraft }
  | { kind: "plan"; decision: "decline"; draft: PlanDraft; resumeInstruction: string };

type GateResolution = { kind: "questions"; message: string } | PlanGateResolution;

interface PauseGate {
  runId: string;
  kind: "questions" | "plan";
  resolve: (value: GateResolution) => void;
  reject: (err: Error) => void;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  gates: Set<PauseGate>;
}

export interface StartRunInput {
  prompt: string;
  flavor: AppRunFlavor;
  attachments?: string[];
}

// ----------------------------------------------------------------------------
// The engine
// ----------------------------------------------------------------------------

export class AppRunEngine {
  private active = new Map<string, ActiveRun>();
  /** A decision that arrived between a card/draft becoming visible and the run parking on it. */
  private pending = new Map<string, GateResolution>();

  constructor(private deps: AppEngineDeps) {}

  /** The active (executing or user-parked) run of a project, if any. */
  activeRunFor(projectId: string): { runId: string } | undefined {
    const entry = this.active.get(projectId);
    return entry ? { runId: entry.runId } : undefined;
  }

  /** The run's park state, for the routes' 409 contracts. */
  waitingFor(projectId: string): "questions" | "plan" | null {
    const entry = this.active.get(projectId);
    if (!entry) return null;
    for (const gate of entry.gates) return gate.kind;
    return null;
  }

  /**
   * POST /runs (§4.15.2): starts the run, or queues it when one is active.
   * Conflict errors are returned, not thrown.
   */
  startRun(project: AppProject, input: StartRunInput): { runId: string } | { queued: import("./types.js").PromptQueueItem } | { error: string } {
    const prompt = input.prompt.trim();
    if (!prompt) return { error: "prompt_required" };
    if (project.status === "editing") return { error: "edit_session_open" };
    if (activeRaceFor(project.id)) return { error: "race_running" };
    if (this.active.has(project.id)) {
      // §4.15.2: queues when a run is active; the composer shows "Queued (n)".
      const queued = enqueuePrompt(project.id, prompt, input.flavor, input.attachments ?? []);
      return "error" in queued ? { error: queued.error } : { queued };
    }
    const run = insertRun({ projectId: project.id, flavor: input.flavor, prompt });
    const controller = new AbortController();
    this.active.set(project.id, { runId: run.id, controller, gates: new Set() });
    this.setStatus(project.id, input.flavor === "quick" ? "building" : "clarifying");
    const signal = controller.signal;
    // §4.11.2: every run of a project holds the app:<projectId> lock, so two
    // runs of one project never overlap while runs of different projects can.
    void executionQueue
      .enqueue(`apprun:${run.id}`, async () => this.executeRun(getAppProject(project.id) ?? project, run.id, input, signal), signal, [`app:${project.id}`])
      .catch(() => undefined); // executeRun settles its own errors; this covers an abort while queued
    return { runId: run.id };
  }

  /** POST /runs/:runId/stop (§4.15.2): aborts the run and unparks its gates. */
  stopRun(projectId: string, runId: string): boolean {
    const entry = this.active.get(projectId);
    if (!entry || entry.runId !== runId) return false;
    for (const gate of [...entry.gates]) gate.reject(new RunStoppedError());
    entry.controller.abort();
    return true;
  }

  /** Route-side resume for the questions card: resolveQuestionsCard already ran. */
  resolveQuestionsGate(projectId: string, cardId: string, message: string, status: "answered" | "skipped"): boolean {
    const entry = this.active.get(projectId);
    if (!entry) return false;
    emitProjectEvent(projectId, "appQuestionsResolved", { projectId, cardId, status });
    const gate = [...entry.gates].find((g) => g.kind === "questions");
    if (gate) {
      gate.resolve({ kind: "questions", message });
      entry.gates.delete(gate);
    } else {
      // The card row is visible before the run parks on it; buffer the decision.
      this.pending.set(projectId, { kind: "questions", message });
    }
    return true;
  }

  /** Route-side resume for the plan decision (approve or decline; edit re-arms the gate). */
  resolvePlanGate(projectId: string, resolution: PlanGateResolution): boolean {
    const entry = this.active.get(projectId);
    if (!entry) return false;
    emitProjectEvent(projectId, "appPlanDecided", {
      projectId,
      draftId: resolution.draft.id,
      revision: resolution.draft.revision,
      decision: resolution.decision === "approve" ? "approved" : "declined",
      ...(resolution.decision === "decline" && resolution.resumeInstruction ? { reason: resolution.resumeInstruction.slice(0, 1_000) } : {}),
    });
    const gate = [...entry.gates].find((g) => g.kind === "plan");
    if (gate) {
      gate.resolve(resolution);
      entry.gates.delete(gate);
    } else {
      // The draft row is visible before the run parks on it; buffer the decision.
      this.pending.set(projectId, resolution);
    }
    return true;
  }

  // -------------------------------------------------------------------------- internals

  private setStatus(projectId: string, status: AppProjectStatus): void {
    updateAppProjectRow(projectId, { status });
    emitProjectEvent(projectId, "appProjectStatus", { projectId, status });
  }

  private failRun(projectId: string, runId: string): void {
    finishRun(runId, "failed");
    this.setStatus(projectId, "failed");
    // §4.11.2: a failed run pauses the queue automatically (the composer offers Resume).
    setQueuePaused(projectId, true);
  }

  private async waitGate(projectId: string, kind: "questions" | "plan", runId: string): Promise<GateResolution> {
    const entry = this.active.get(projectId)!;
    const buffered = this.pending.get(projectId);
    if (buffered) {
      this.pending.delete(projectId);
      return buffered;
    }
    return new Promise<GateResolution>((resolve, reject) => {
      const gate: PauseGate = {
        runId, kind,
        resolve: (value) => { entry.gates.delete(gate); resolve(value); },
        reject: (err) => { entry.gates.delete(gate); reject(err); },
      };
      entry.gates.add(gate);
    });
  }

  private leadExecutor(project: AppProject, runId: string, step: AppStep, signal?: AbortSignal): LeadExecutor {
    return {
      call: async ({ messages }) => {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const result = await this.deps.runRoleTurn({
          project, runId, role: "lead", step,
          system: messages[0]?.role === "system" ? messages[0].content : LEAD_SYSTEM,
          prompt: lastUser?.content ?? "",
          tools: APP_ROLES.lead.tools,
          maxToolCalls: APP_ROLES.lead.maxToolCalls,
          signal,
        });
        return { text: result.text };
      },
    };
  }

  private async turn(
    ctx: { project: AppProject; runId: string; signal?: AbortSignal },
    role: AppRoleId,
    step: AppStep,
    system: string,
    prompt: string,
    extra: { workspaceDir?: string; maxToolCalls?: number; temperature?: number } = {},
  ): Promise<RoleTurnResult> {
    // Cloud-only model selection per step (§4.12.2): NoCloudModelError aborts the run.
    const picked = this.deps.pickModel(ctx.project, role, step);
    const started = Date.now();
    const result = await this.deps.runRoleTurn({
      project: ctx.project, runId: ctx.runId, role, step, system, prompt,
      tools: APP_ROLES[role].tools,
      ...(extra.workspaceDir ? { workspaceDir: extra.workspaceDir } : {}),
      maxToolCalls: extra.maxToolCalls ?? APP_ROLES[role].maxToolCalls,
      ...(extra.temperature !== undefined ? { temperature: extra.temperature } : {}),
      signal: ctx.signal,
    });
    // §4.14 metering: one row per role turn.
    recordAppUsage({
      projectId: ctx.project.id, runId: ctx.runId, role, step, kind: "build", tier: picked.tier,
      promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
      cachedTokens: result.usage.cachedTokens, toolCalls: result.usage.toolCalls,
      durationMs: result.usage.durationMs || Math.max(1, Date.now() - started),
    });
    return result;
  }

  private appDirEmpty(project: AppProject): boolean {
    try {
      return fs.readdirSync(path.join(project.workspaceDir, project.appDir)).length === 0;
    } catch {
      return true;
    }
  }

  private async executeRun(project: AppProject, runId: string, input: StartRunInput, signal: AbortSignal): Promise<void> {
    const ctx = { project, runId, signal };
    try {
      // scaffold phase (§4.1: skipped when the app dir already has content)
      if (!shouldSkipPhase("scaffold", {
        appDirEmpty: this.appDirEmpty(project),
        designDocExists: fs.existsSync(path.join(project.workspaceDir, "DESIGN.md")),
        questionsSkipped: false,
      })) {
        await this.deps.scaffold(project);
      }
      if (input.flavor === "quick") await this.runQuick(ctx, input.prompt);
      else await this.runGoal(ctx, input.prompt);
    } catch (err) {
      if (err instanceof NoCloudModelError) {
        // CLOUD-ONLY (§4.12.2): abort the run with a clear Arabic error.
        this.failRun(project.id, runId);
        return;
      }
      if (err instanceof RunStoppedError || err instanceof CancelledError || signal.aborted) {
        finishRun(runId, "stopped");
        this.setStatus(project.id, "idle");
        return;
      }
      this.failRun(project.id, runId);
      return;
    } finally {
      clearAppBuild(project.taskId);
      this.deps.verify.endRun(runId);
      takeVersionNote(runId);
      takeAddedPackages(runId);
      this.pending.delete(project.id);
      this.active.delete(project.id);
      this.pumpQueue(project.id);
    }
  }

  // ------------------------------------------------------------------ Build (quick)

  private async runQuick(ctx: { project: AppProject; runId: string; signal?: AbortSignal }, prompt: string): Promise<void> {
    const { project, runId } = ctx;
    // §4.12.2: pick the model BEFORE any work; a local-only config aborts now.
    this.deps.pickModel(project, "engineer", "implement");
    setActiveAppBuild({ project, runId, verify: this.deps.verify });
    this.setStatus(project.id, "building");

    const designDocExists = fs.existsSync(path.join(project.workspaceDir, "DESIGN.md"));
    const engineerPrompt = [
      "The user's request:",
      "",
      prompt,
      "",
      designDocExists ? "DESIGN.md exists at the workspace root: follow it." : "DESIGN.md does not exist at the workspace root: write it first, then build.",
      "Follow your work rules. Finish with your report.",
    ].join("\n");
    await this.turn(ctx, "engineer", "implement", ENGINEER_SYSTEM, engineerPrompt);

    await this.verifyAndVersion(ctx, prompt);
    finishRun(runId, "done");
    this.setStatus(project.id, "idle");
  }

  // ------------------------------------------------------------------ Goal

  private async runGoal(ctx: { project: AppProject; runId: string; signal?: AbortSignal }, prompt: string): Promise<void> {
    const { project, runId } = ctx;
    this.deps.pickModel(project, "lead", "clarify");
    setActiveAppBuild({ project, runId, verify: this.deps.verify });

    // STEP clarify (§4.2.1): the run parks on the card until the user answers.
    let questionsMessage: string | undefined;
    const clarify = await runLeadClarify({
      project, runId, userPrompt: prompt,
      executor: this.leadExecutor(project, runId, "clarify", ctx.signal),
    });
    if (clarify.kind === "questions_card") {
      emitProjectEvent(project.id, "appQuestionsRequested", { projectId: project.id, card: clarify.card });
      const gate = await this.waitGate(project.id, "questions", runId);
      if (gate.kind === "questions") questionsMessage = gate.message;
    }

    // STEP plan (§4.2.2) with the approval gate; a decline loops back per revision.
    let approved: PlanDraft | undefined;
    let declineMessage: string | undefined;
    for (let revision = 0; revision < MAX_PLAN_REVISIONS && !approved; revision++) {
      const planned = await runLeadPlan({
        project, runId, userPrompt: prompt,
        executor: this.leadExecutor(project, runId, "plan", ctx.signal),
        contextMessage: questionsMessage ?? declineMessage,
      });
      if (planned.kind === "invalid_plan") {
        this.failRun(project.id, runId);
        return;
      }
      emitProjectEvent(project.id, "appPlanDraft", { projectId: project.id, draft: planned.draft });
      const decision = await this.waitGate(project.id, "plan", runId);
      if (decision.kind === "plan" && decision.decision === "approve") approved = decision.draft;
      else if (decision.kind === "plan") declineMessage = decision.resumeInstruction;
    }
    if (!approved) {
      // Too many declined revisions in one run: stop cleanly; the user can send again.
      finishRun(runId, "stopped");
      this.setStatus(project.id, "idle");
      return;
    }

    // STEP assign (§4.2.4): the Lead turn creates assignments through
    // app_task_create; anything left uncovered gets the bundled default.
    await this.turn(ctx, "lead", "assign", LEAD_SYSTEM, assignPrompt(approved, prompt));
    for (const a of this.ensureAssignments(project, approved)) {
      await this.runAssignment(ctx, a);
    }

    // STEP finish (§4.2.4): the Lead reads the reports (and may call
    // app_task_finish); anything it left is finished deterministically.
    const reports = listAssignments(project.id)
      .filter((a) => a.planDraftId === approved.id && a.report)
      .map((a) => `- ${a.id} (${a.role}, ${a.status}): ${a.report!.slice(0, 400)}`)
      .join("\n");
    await this.turn(ctx, "lead", "finish", LEAD_SYSTEM, finishLeadPrompt(approved, reports));
    for (const a of listAssignments(project.id).filter((x) => x.planDraftId === approved!.id && (x.status === "running" || x.status === "queued"))) {
      finishAssignmentForPlan(project, {
        assignmentId: a.id,
        outcome: a.status === "queued" ? "failed" : "done",
        summary: a.report?.slice(0, 1200) || "No report was produced for this assignment.",
      });
    }

    await this.verifyAndVersion(ctx, prompt);
    finishRun(runId, "done");
    this.setStatus(project.id, "idle");
  }

  /** After the Lead's assign turn: the bundled-default fallback (§4.2.4 rule 3). */
  private ensureAssignments(project: AppProject, draft: PlanDraft): AppTaskAssignment[] {
    const existing = listAssignments(project.id).filter((a) => a.planDraftId === draft.id);
    const covered = new Set(existing.flatMap((a) => a.planTaskIds));
    const uncovered = draft.doc.tasks.filter((t) => !covered.has(t.id) && t.status === "pending").map((t) => t.id);
    if (uncovered.length > 0) {
      const fallback = createAssignmentForPlan(project, {
        role: "engineer",
        planTaskIds: uncovered,
        brief: [
          `Goal: build the approved plan "${draft.doc.title}" end to end.`,
          `Approved scope: ${draft.doc.overview}`,
          "Out of scope: anything the plan does not list.",
          `Acceptance statements: ${draft.doc.tasks.filter((t) => uncovered.includes(t.id)).map((t) => `${t.id}: ${t.acceptance.join("; ")}`).join(" | ")}`,
          "Context files to read first: .loam/context/PROJECT.md, .loam/context/PROGRESS.md, .loam/context/ARCHITECTURE.md.",
          "Report what works, what you checked, and what you could not check.",
        ].join("\n"),
      });
      if (fallback.ok) existing.push(fallback.assignment);
    }
    const queued = existing.filter((a) => a.status === "queued");
    for (const a of queued) emitProjectEvent(project.id, "appAssignment", { projectId: project.id, assignment: a });
    return queued;
  }

  private async runAssignment(ctx: { project: AppProject; runId: string; signal?: AbortSignal }, assignment: AppTaskAssignment): Promise<void> {
    const { project } = ctx;
    const running = updateAssignment(assignment.id, { status: "running" });
    if (running) emitProjectEvent(project.id, "appAssignment", { projectId: project.id, assignment: running });
    const draft = latestPlanDraft(project.id);
    const isEngineer = assignment.role === "engineer";
    const designDocExists = fs.existsSync(path.join(project.workspaceDir, "DESIGN.md"));
    const contextPaths = [".loam/context/PROJECT.md", ".loam/context/PROGRESS.md", ...(draft ? [".loam/context/ARCHITECTURE.md"] : [])];
    const brief = isEngineer
      ? engineerBriefPreamble({ brief: assignment.brief, contextPaths, designDocExists })
      : assignment.brief;
    const system = isEngineer ? ENGINEER_SYSTEM : (ROLE_SYSTEM[assignment.role as keyof typeof ROLE_SYSTEM] ?? ROLE_SYSTEM.research);
    let outcome: "done" | "failed" = "done";
    let report = "";
    try {
      const result = await this.turn(ctx, assignment.role, isEngineer ? "implement" : "role-work", system, brief);
      report = result.text.trim();
      if (!report) outcome = "failed";
    } catch (err) {
      if (err instanceof RunStoppedError || err instanceof CancelledError || ctx.signal?.aborted) throw err;
      outcome = "failed";
      report = `Assignment failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const finished = finishAssignmentForPlan(project, {
      assignmentId: assignment.id,
      outcome,
      summary: report.slice(0, 1200) || "The role returned an empty report.",
    });
    if (finished.ok) emitProjectEvent(project.id, "appAssignment", { projectId: project.id, assignment: finished.assignment });
  }

  // ------------------------------------------------------------------ verify + version (§4.6, §4.7)

  private async verifyAndVersion(ctx: { project: AppProject; runId: string; signal?: AbortSignal }, prompt: string): Promise<void> {
    const { project, runId } = ctx;
    const flavor = getRun(runId)?.flavor ?? "quick";
    updateRun(runId, { status: "verifying" });
    this.setStatus(project.id, "verifying");
    // The Engineer may already have called app_verify inside its turn; reuse it.
    let report: VerifyReport | undefined = latestVerifyReportForRun(runId);
    if (!report) {
      report = await this.deps.verify.run({ project, runId, tier: resolveVerifyTier(project, flavor), signal: ctx.signal });
      insertVerifyReport(report);
      writeVerificationSummary(project.workspaceDir, verificationSummaryLine(report, project));
      emitProjectEvent(project.id, "appVerifyReport", {
        requestId: report.id, projectId: project.id, runId, attempt: report.attempt,
        tier: report.tier, pass: report.pass, error: report.error,
      });
    }

    updateRun(runId, { status: "versioning" });
    this.setStatus(project.id, "versioning");
    // §4.6.7 + §4.7.3: app_version_note wins; otherwise one fast title call.
    const note = takeVersionNote(runId)
      ?? await this.deps.nameVersion({ project, prompt, engineerReport: "", versionNumber: (project.activeVersion ?? 0) + 1 });
    const usage = versionUsageSummary(appUsage(project.id, runId).rows);
    let version: AppVersion | null = null;
    try {
      version = await this.deps.versions.snapshot(project, {
        title: note.title, summary: note.summary, source: "build",
        verifyReportId: report.id, usage, addedPackages: takeAddedPackages(runId),
      });
    } catch {
      version = null; // a git failure must not lose the run's work
    }
    if (version) {
      updateAppProjectRow(project.id, { activeVersion: version.number });
      emitProjectEvent(project.id, "appVersion", { projectId: project.id, phase: "created", version });
    }
  }

  // ------------------------------------------------------------------ queue pump (§4.11.2)

  /** Public pump for the routes: starts the next queued prompt when the project is free. */
  pumpProjectQueue(projectId: string): void {
    this.pumpQueue(projectId);
  }

  private pumpQueue(projectId: string): void {
    void (async () => {
      try {
        const project = getAppProject(projectId);
        if (!project) return;
        if (this.active.has(projectId)) return;
        if (activeRaceFor(projectId)) return;
        if (["clarifying", "awaiting_approval", "editing", "racing"].includes(project.status)) return;
        if (queueState(projectId).paused) return;
        const item = takeNextQueued(projectId);
        if (!item) return;
        try {
          const started = this.startRun(project, { prompt: item.content, flavor: item.flavor, attachments: item.attachments });
          if ("error" in started) throw new Error(started.error);
          markQueueItemSent(item.id);
        } catch (err) {
          markQueueItemFailed(projectId, item.id, err instanceof Error ? err.message : String(err));
        }
      } catch {
        /* the pump must never throw into a run's finally */
      }
    })();
  }
}

function assignPrompt(draft: PlanDraft, userPrompt: string): string {
  const tasks = draft.doc.tasks.map((t) => `${t.id} (${t.role}): ${t.title} [deps: ${t.deps.join(", ") || "none"}]`).join("\n");
  return [
    `The user's request: ${userPrompt}`,
    "",
    `The approved plan "${draft.doc.title}" (revision ${draft.revision}):`,
    tasks,
    "",
    "STEP assign: give the work out now with app_task_create. Put every engineer task in one assignment unless two groups touch no common files.",
  ].join("\n");
}

function finishLeadPrompt(draft: PlanDraft, reports: string): string {
  return [
    `All assignments of plan "${draft.doc.title}" have run. Their reports:`,
    reports || "(none)",
    "",
    "STEP finish: call app_task_finish once per assignment with done or failed and the summary, then write the final message to the user (2 to 4 sentences, one suggested next step, no file lists).",
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Default implementations (the real wiring; tests inject stubs)
// ----------------------------------------------------------------------------

/**
 * The default role runner: one runAgent turn per role through stepRouting's
 * cloud-only model selection, with the registry filtered to the role's tools
 * and the §4.2.3 write-scope gate applied.
 */
export function createRunAgentRoleRunner(opts: {
  cfg: () => Config;
  ollama: () => OllamaClient;
  baseTools: () => ToolRegistry;
  emit?: Emit;
}): RoleTurnRunner {
  return async (input) => {
    const { runAgent } = await import("../agent/loop.js");
    const cfg = opts.cfg();
    const picked = modelForStep(cfg, input.project, input.role, input.step); // throws NoCloudModelError
    const base = opts.baseTools();
    const sub = base.cloneFiltered({ allow: [...input.tools] });
    applyRoleScopeGate(sub, () => input.role);
    const runCfg: Config = { ...cfg, workspace: input.workspaceDir ?? cfg.workspace };
    const events: import("../agent/events.js").AgentEvent[] = [];
    const emit: Emit = (e) => { events.push(e); opts.emit?.(e); };
    const result = await runAgent({
      cfg: input.temperature !== undefined ? { ...runCfg, agent: { ...runCfg.agent, temperature: input.temperature } } : runCfg,
      ollama: opts.ollama(),
      tools: sub,
      emit,
      prompt: input.prompt,
      systemOverride: input.system,
      model: picked.model,
      maxSteps: Math.max(4, Math.ceil((input.maxToolCalls ?? APP_ROLES[input.role].maxToolCalls) / 2)),
      ...(input.signal ? { signal: input.signal } : {}),
      taskId: input.project.taskId,
    });
    return {
      text: result.text,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens ?? 0,
        toolCalls: events.filter((e) => e.type === "tool_call").length,
        durationMs: result.usage.durationMs,
      },
    };
  };
}

/** The default version namer: one fast-class call with VERSION_TITLE_SYSTEM (§4.7.3). */
export function createModelVersionNamer(runner: RoleTurnRunner): VersionNamer {
  return async (input) => {
    try {
      const result = await runner({
        project: input.project, runId: "version_title", role: "lead", step: "version-title",
        system: VERSION_TITLE_SYSTEM,
        prompt: ["User request:", input.prompt.slice(0, 1_500), "", `Version ${input.versionNumber} of this project.`, "", "Engineer report:", input.engineerReport.slice(0, 2_000)].join("\n"),
        tools: [],
        maxToolCalls: 0,
      });
      const parsed = extractJson(result.text) as { title?: unknown; summary?: unknown } | null;
      if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
        return {
          title: parsed.title.trim().slice(0, 60),
          summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 600) : `Version ${input.versionNumber} of this app.`,
        };
      }
    } catch {
      /* fall through to the deterministic fallback */
    }
    const words = input.prompt.trim().split(/\s+/).slice(0, 6).join(" ");
    return { title: words || `Version ${input.versionNumber}`, summary: `Version ${input.versionNumber} of this app.` };
  };
}

/** The default scaffold (§4.3): template files into an empty app/, shared deps, junction, lockfile. */
export async function scaffoldProject(project: AppProject, onLine: (line: string) => void = () => undefined): Promise<void> {
  const appDir = path.join(project.workspaceDir, project.appDir);
  for (const file of loadTemplate(project.templateId, project.features).files) {
    const target = path.join(appDir, file.path);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }
  const folder = await ensureDepsFolder(project, onLine);
  copyLockfileIntoProject(project);
  const nodeModules = path.join(appDir, "node_modules");
  if (project.depsMode === "shared" && !fs.existsSync(nodeModules)) {
    try {
      fs.symlinkSync(path.join(folder.dir, "node_modules"), nodeModules, "junction");
    } catch {
      /* Windows may refuse the junction; the verify install step retries */
    }
  }
}

/** Zero-usage turn result for stubs that never talked to a model. */
export function stubTurn(text: string): RoleTurnResult {
  return { text, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, toolCalls: 0, durationMs: 1 } };
}

export { zeroUsage };
