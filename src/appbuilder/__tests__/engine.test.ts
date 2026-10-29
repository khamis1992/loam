// src/appbuilder/__tests__/engine.test.ts — W3-c M2 gate: the AppRunEngine on
// fixtures (NO live model). The RoleTurnRunner, VerifyLoop, scaffold and
// version namer are stubs; the version store is the real git-backed
// VersionService, so snapshots/refs are exercised for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-engine-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { ensureAppBuilderSchema, finishRun, getRun, latestPlanDraft, listAssignments, listQuestionCards, listRuns } = await import("../store.js");
const { createAppProject, getAppProject } = await import("../projects.js");
const { AppRunEngine, RunStoppedError, NO_CLOUD_MODEL_AR } = await import("../engine.js");
const { VersionService, appVersionRows } = await import("../versions.js");
const { approvePlanDraft, declinePlanDraft, resolveQuestionsCard } = await import("../lead.js");
const { NoCloudModelError } = await import("../stepRouting.js");
const { database } = await import("../../server/sqliteStore.js");
const { after } = await import("../../protocol/eventLog.js");
const { projectSession } = await import("../events.js");
const { queueState } = await import("../promptQueue.js");
import type { AppEngineDeps, RoleTurnInput, RoleTurnResult } from "../engine.js";
import type { AppStep } from "../stepRouting.js";
const type = (t: unknown, m = ""): void => { assert.ok(t, m); };

ensureAppBuilderSchema();

// ---------------------------------------------------------------- fixtures

const versions = new VersionService(appVersionRows);

const GREEN_REPORT = {
  id: "vr_stub1", projectId: "", runId: "", attempt: 1, tier: "fast" as const, pass: true,
  steps: [
    { id: "placeholder" as const, command: null, ok: true, skipped: false, durationMs: 1, exitCode: null, outputTail: "" },
    { id: "check" as const, command: "npm run check", ok: true, skipped: false, durationMs: 2, exitCode: 0, outputTail: "" },
    { id: "build" as const, command: "npm run build", ok: true, skipped: false, durationMs: 3, exitCode: 0, outputTail: "" },
  ],
  consoleErrors: 0, screenshots: [], visualVerdict: "pass" as const, visualNotes: "",
  logPath: "", error: null, startedAt: "", finishedAt: "",
};

let verifySeq = 0;
const verifyStub = {
  async run(o: { project: { id: string }; runId: string }) {
    verifySeq += 1;
    return { ...GREEN_REPORT, id: `vr_stub${verifySeq}`, projectId: o.project.id, runId: o.runId };
  },
  endRun() {},
};

async function scaffoldStub(project: Parameters<AppEngineDeps["scaffold"]>[0]): Promise<void> {
  const appDir = path.join(project.workspaceDir, "app");
  fs.mkdirSync(path.join(appDir, "src", "pages"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "src", "pages", "Index.tsx"), "export default function Index() { return <main>built</main>; }\n", "utf8");
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "app", private: true }, null, 2), "utf8");
}

const QUESTIONS_JSON = JSON.stringify({
  title: "Quick check",
  questions: [{
    id: "q1", prompt: "Who will use this app day to day?", kind: "single",
    options: [{ id: "o1", label: "Just me" }, { id: "o2", label: "My team" }],
    defaultOptionIds: ["o1"], allowOther: false,
  }],
});

function planJson(title: string): string {
  return JSON.stringify({
    title,
    overview: "One small app with a list you can add to.",
    scenario: "web_app",
    templateId: "web-app",
    features: [],
    keyDecisions: [{ date: "2026-10-29", decision: "Local only", rationale: "default: the user did not say", source: "default" }],
    constraints: [],
    requirements: ["Shows a list"],
    userStories: [],
    tasks: [
      { id: "T1", title: "Build the list page", role: "engineer", deps: [], status: "pending", acceptance: ["The page renders"] },
      { id: "T2", title: "Verify the flow", role: "engineer", deps: ["T1"], status: "pending", acceptance: ["Reload keeps items"] },
    ],
  });
}

interface ScriptedRunner {
  calls: Array<{ role: string; step: AppStep; prompt: string }>;
  /** Hook called before each turn; may block (used by the stop/queue tests). */
  beforeTurn?: (input: RoleTurnInput) => Promise<void>;
  reply(input: RoleTurnInput): string;
}

function scriptedRunner(script: (input: RoleTurnInput, calls: Array<{ role: string; step: AppStep; prompt: string }>) => string, hooks: { beforeTurn?: (input: RoleTurnInput) => Promise<void> } = {}): ScriptedRunner {
  const calls: Array<{ role: string; step: AppStep; prompt: string }> = [];
  return {
    calls,
    beforeTurn: hooks.beforeTurn,
    reply(input) {
      calls.push({ role: input.role, step: input.step, prompt: input.prompt });
      return script(input, calls);
    },
  };
}

function depsFor(runner: ScriptedRunner, overrides: Partial<AppEngineDeps> = {}): AppEngineDeps {
  return {
    pickModel: () => ({ model: "stub-cloud", tier: "max" }),
    async runRoleTurn(input) {
      await runner.beforeTurn?.(input);
      const text = runner.reply(input);
      const result: RoleTurnResult = { text, usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 0, toolCalls: 1, durationMs: 5 } };
      return result;
    },
    verify: verifyStub,
    versions,
    scaffold: scaffoldStub,
    stopAppServer: async () => {},
    nameVersion: async () => ({ title: "First build", summary: "The app builds and passes its checks." }),
    ...overrides,
  };
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function appEvents(projectId: string): Array<{ kind: string; payload: { type?: string } }> {
  return after(projectSession(projectId)).map((e) => ({ kind: e.kind, payload: e.payload as { type?: string } }));
}

function chatEventTypes(projectId: string): string[] {
  return appEvents(projectId)
    .filter((e) => e.kind === "chat_event")
    .map((e) => e.payload.type ?? "");
}

// ---------------------------------------------------------------- Build (quick)

test("engine quick: engineer turn → verify → snapshot v1 → done, events + usage", async () => {
  const project = createAppProject({ title: "quick-run", baseWorkspace: tmp });
  const runner = scriptedRunner((input) => `Engineer report: built the page, verified with app_verify, all green. Files changed: app/src/pages/Index.tsx`);
  const engine = new AppRunEngine(depsFor(runner));
  const started = engine.startRun(project, { prompt: "ابنِ صفحة قائمة مهام", flavor: "quick" });
  type(!("error" in started), "run starts");
  const runId = (started as { runId: string }).runId;
  await waitFor("run done", () => getRun(runId)?.status === "done");
  assert.equal(getRun(runId)!.status, "done");
  // one engineer turn, cloud model picked before it
  assert.deepEqual(runner.calls.map((c) => `${c.role}:${c.step}`), ["engineer:implement"]);
  // version 1 created by the real git store
  const rows = (database().prepare("SELECT number, title, source FROM app_versions WHERE project_id = ?").all(project.id) as Array<{ number: number; title: string; source: string }>).map((r) => ({ number: r.number, title: r.title, source: r.source }));
  assert.deepEqual(rows, [{ number: 1, title: "First build", source: "build" }]);
  assert.equal(getAppProject(project.id)!.activeVersion, 1);
  assert.equal(getAppProject(project.id)!.status, "idle");
  // §4.14 metering row for the engineer turn
  const usage = database().prepare("SELECT role, step FROM app_usage WHERE run_id = ?").all(runId) as Array<{ role: string; step: string }>;
  assert.ok(usage.some((u) => u.role === "engineer" && u.step === "implement"), "engineer usage row exists");
  // §4.15.1 events: verify report, version, project status transitions
  const types = chatEventTypes(project.id);
  assert.ok(types.includes("appVerifyReport"), "appVerifyReport emitted");
  assert.ok(types.includes("appVersion"), "appVersion emitted");
  assert.ok(types.includes("appProjectStatus"), "appProjectStatus emitted");
});

// ---------------------------------------------------------------- Goal happy path with both pauses

test("engine goal: questions pause → resume → plan pause → approve → assignments → verify → snapshot", async () => {
  const project = createAppProject({ title: "goal-run", baseWorkspace: tmp });
  const runner = scriptedRunner((input) => {
    if (input.step === "clarify") return QUESTIONS_JSON;
    if (input.step === "plan") return planJson("قائمة المهام");
    if (input.step === "assign") return "Assigned all tasks to the engineer in one assignment.";
    if (input.step === "finish") return "Everything is ready. Try adding your first item.";
    return "Role report: what works — the page; what I verified — app_verify green; what I could not — nothing. Files changed: app/src/pages/Index.tsx";
  });
  const engine = new AppRunEngine(depsFor(runner));
  const started = engine.startRun(project, { prompt: "تطبيق قائمة مهام بسيط", flavor: "goal" });
  type(!("error" in started));
  const runId = (started as { runId: string }).runId;

  // questions card parks the run (§4.2.1)
  await waitFor("questions card", () => listQuestionCards(project.id).some((c) => c.status === "pending"));
  const card = listQuestionCards(project.id).find((c) => c.status === "pending")!;
  assert.equal(engine.waitingFor(project.id), "questions");
  assert.equal(getRun(runId)!.status, "running", "the run row waits while the card is pending");
  const answered = resolveQuestionsCard(project, card.id, { answers: [{ questionId: "q1", optionIds: ["o2"] }] });
  type(answered.ok, "card answers");
  type(engine.resolveQuestionsGate(project.id, card.id, answered.ok ? answered.leadMessage : "", "answered"));

  // plan draft parks the run again (§4.2.2)
  await waitFor("plan draft", () => latestPlanDraft(project.id)?.status === "draft");
  const draft = latestPlanDraft(project.id)!;
  assert.equal(engine.waitingFor(project.id), "plan");
  assert.equal(getAppProject(project.id)!.status, "awaiting_approval");
  const approved = approvePlanDraft(project, draft.revision);
  type(approved.ok, `approve ok: ${approved.ok ? "" : approved.error}`);
  // §4.2.2 rule 6: approval renders the context files atomically
  assert.ok(fs.existsSync(path.join(project.workspaceDir, ".loam", "context", "PROJECT.md")), "PROJECT.md written on approval");
  type(engine.resolvePlanGate(project.id, { kind: "plan", decision: "approve", draft: approved.ok ? approved.draft : draft }));

  await waitFor("run done", () => getRun(runId)?.status === "done");
  // the bundled-default assignment ran and finished both plan tasks
  const assignments = listAssignments(project.id);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0]!.status, "done");
  assert.equal(assignments[0]!.role, "engineer");
  const after = latestPlanDraft(project.id)!;
  assert.ok(after.doc.tasks.every((t) => t.status === "done"), `plan tasks done, got ${after.doc.tasks.map((t) => t.status).join(",")}`);
  assert.equal(getAppProject(project.id)!.activeVersion, 1);
  const types = chatEventTypes(project.id);
  for (const expected of ["appQuestionsRequested", "appQuestionsResolved", "appPlanDraft", "appPlanDecided", "appAssignment", "appVersion"]) {
    assert.ok(types.includes(expected), `${expected} emitted`);
  }
});

test("engine goal: decline resumes the Lead for revision n+1", async () => {
  const project = createAppProject({ title: "goal-decline", baseWorkspace: tmp });
  let planCalls = 0;
  const runner = scriptedRunner((input) => {
    if (input.step === "clarify") return '{"questions":[]}';
    if (input.step === "plan") { planCalls += 1; return planJson(planCalls === 1 ? "خطة أولى" : "خطة معدّلة"); }
    if (input.step === "assign") return "assigned";
    if (input.step === "finish") return "done";
    return "report ok";
  });
  const engine = new AppRunEngine(depsFor(runner));
  const started = engine.startRun(project, { prompt: "مدونة صغيرة", flavor: "goal" });
  const runId = (started as { runId: string }).runId;

  await waitFor("draft 1", () => latestPlanDraft(project.id)?.revision === 1 && latestPlanDraft(project.id)?.status === "draft");
  const declined = declinePlanDraft(project, "أريد إضافة صفحة أرشيف");
  type(declined.ok);
  type(engine.resolvePlanGate(project.id, { kind: "plan", decision: "decline", draft: declined.ok ? declined.draft : latestPlanDraft(project.id)!, resumeInstruction: declined.ok ? declined.resumeInstruction! : "revise" }));
  await waitFor("draft 2", () => latestPlanDraft(project.id)?.revision === 2 && latestPlanDraft(project.id)?.status === "draft");
  // the decline instruction reached the Lead's second plan ask
  const planAsk = runner.calls.filter((c) => c.step === "plan")[1]!;
  assert.ok(planAsk.prompt.includes("أريد إضافة صفحة أرشيف"), "decline reason is passed as untrusted input");
  const approved = approvePlanDraft(project, 2);
  type(approved.ok);
  type(engine.resolvePlanGate(project.id, { kind: "plan", decision: "approve", draft: approved.ok ? approved.draft : latestPlanDraft(project.id)! }));
  await waitFor("run done", () => getRun(runId)?.status === "done");
});

// ---------------------------------------------------------------- cloud-only

test("engine cloud-only: a local-only model config aborts the run (Arabic error, queue paused)", async () => {
  const project = createAppProject({ title: "local-only", baseWorkspace: tmp });
  const runner = scriptedRunner(() => "never called");
  const engine = new AppRunEngine(depsFor(runner, {
    pickModel: () => { throw new NoCloudModelError(); },
  }));
  const started = engine.startRun(project, { prompt: "أي شيء", flavor: "quick" });
  type(!("error" in started));
  const runId = (started as { runId: string }).runId;
  await waitFor("run failed", () => getRun(runId)?.status === "failed");
  assert.equal(getRun(runId)!.status, "failed");
  assert.equal(getAppProject(project.id)!.status, "failed");
  assert.equal(runner.calls.length, 0, "no model turn ever ran");
  // §4.11.2: a failed run pauses the queue automatically
  assert.equal(queueState(project.id).paused, true);
  // the Arabic error text ships from the engine module for the error card
  assert.ok(NO_CLOUD_MODEL_AR.includes("نموذجًا سحابيًا"));
  type(typeof RunStoppedError === "function");
});

// ---------------------------------------------------------------- queue serialization + stop

test("engine queue: a second run of the same project queues, then starts when the first ends", async () => {
  const project = createAppProject({ title: "serialize", baseWorkspace: tmp });
  let releaseFirst = (): void => {};
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let turn = 0;
  const runner = scriptedRunner(() => {
    turn += 1;
    return "report: done and verified.";
  }, {
    beforeTurn: async () => { if (turn === 0) await gate; },
  });
  const engine = new AppRunEngine(depsFor(runner));
  const first = engine.startRun(project, { prompt: "الأولى", flavor: "quick" });
  const run1 = (first as { runId: string }).runId;
  await waitFor("first active", () => engine.activeRunFor(project.id)?.runId === run1);
  // §4.15.2: a run while one is active is queued, not started
  const second = engine.startRun(project, { prompt: "الثانية", flavor: "quick" });
  type("queued" in second, `second queues, got ${JSON.stringify(second)}`);
  assert.equal(getRun(run1)!.status, "running");
  releaseFirst();
  await waitFor("first done", () => getRun(run1)?.status === "done");
  await waitFor("second started+done", () => {
    const runs = listRuns(project.id).filter((r) => r.id !== run1 && r.raceId === null);
    return runs.length === 1 && runs[0]!.status === "done";
  });
  const secondRun = listRuns(project.id).find((r) => r.id !== run1)!;
  assert.equal(secondRun.status, "done");
  // the queue item was taken and marked sent (queueState hides sent items; read the row)
  const itemRow = database().prepare("SELECT status FROM app_prompt_queue WHERE project_id = ?").all(project.id) as Array<{ status: string }>;
  assert.equal(itemRow.filter((i) => i.status === "sent").length, 1);
});

test("engine stop: stopRun unparks the gate and finishes the run as stopped", async () => {
  const project = createAppProject({ title: "stoppable", baseWorkspace: tmp });
  const runner = scriptedRunner((input) => {
    if (input.step === "clarify") return QUESTIONS_JSON;
    return "report";
  });
  const engine = new AppRunEngine(depsFor(runner));
  const started = engine.startRun(project, { prompt: "قابل للإيقاف", flavor: "goal" });
  const runId = (started as { runId: string }).runId;
  await waitFor("questions card", () => listQuestionCards(project.id).some((c) => c.status === "pending"));
  // Stop while parked on the card: the gate rejects and the run unwinds.
  type(engine.stopRun(project.id, runId));
  await waitFor("run stopped", () => getRun(runId)?.status === "stopped");
  assert.equal(getAppProject(project.id)!.status, "idle");
  assert.equal(engine.stopRun(project.id, runId), false, "a second stop is a no-op");
  type(typeof finishRun === "function");
});
