import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { Readable, Writable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-g4-routes-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
process.env.LOAM_WORKSPACE = tmp;

const { setAppRuntime } = await import("../../appbuilder/runtime.js");
const { VersionService, appVersionRows } = await import("../../appbuilder/versions.js");
const { AppRunEngine } = await import("../../appbuilder/engine.js");
const { RaceEngine } = await import("../../appbuilder/race.js");
const { getAppProject } = await import("../../appbuilder/projects.js");
const { getRun, getRace, latestPlanDraft, listQuestionCards, listRuns } = await import("../../appbuilder/store.js");

// ---- a stub AppRuntime (W3-c): no live model, real git version store ----

const versions = new VersionService(appVersionRows);
let verifySeq = 0;
const verifyStub = {
  async run(o: { project: { id: string }; runId: string }) {
    verifySeq += 1;
    return {
      id: `vr_rt${verifySeq}`, projectId: o.project.id, runId: o.runId, attempt: 1, tier: "fast" as const, pass: true,
      steps: [{ id: "build" as const, command: "npm run build", ok: true, skipped: false, durationMs: 1, exitCode: 0, outputTail: "" }],
      consoleErrors: 0, screenshots: [], visualVerdict: "pass" as const, visualNotes: "", logPath: "", error: null, startedAt: "", finishedAt: "",
    };
  },
  endRun() {},
};

async function scaffoldStub(project: { workspaceDir: string }): Promise<void> {
  const appDir = path.join(project.workspaceDir, "app");
  fs.mkdirSync(path.join(appDir, "src", "pages"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "src", "pages", "Index.tsx"), "export default function Index() { return <main>rt</main>; }\n", "utf8");
}

const QUESTIONS = JSON.stringify({
  title: "Quick check",
  questions: [{
    id: "q1", prompt: "Who will use this app day to day?", kind: "single",
    options: [{ id: "o1", label: "Just me" }, { id: "o2", label: "My team" }],
    defaultOptionIds: ["o1"], allowOther: false,
  }],
});
const PLAN = JSON.stringify({
  title: "خطة المسار",
  overview: "One small app.",
  scenario: "web_app", templateId: "web-app", features: [],
  keyDecisions: [{ date: "2026-10-29", decision: "d", rationale: "r", source: "default" }],
  constraints: [], requirements: [], userStories: [],
  tasks: [{ id: "T1", title: "Build it", role: "engineer", deps: [], status: "pending", acceptance: ["It renders"] }],
});

const engine = new AppRunEngine({
  pickModel: () => ({ model: "stub-cloud", tier: "max" }),
  async runRoleTurn(input) {
    const text = input.step === "clarify" ? QUESTIONS
      : input.step === "plan" ? PLAN
      : input.step === "assign" ? "assigned"
      : input.step === "finish" ? "It is ready."
      : "Engineer report: built, verified green.";
    return { text, usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0, toolCalls: 1, durationMs: 2 } };
  },
  verify: verifyStub,
  versions,
  scaffold: scaffoldStub,
  stopAppServer: async () => {},
  nameVersion: async () => ({ title: "Route build", summary: "Built through the routes." }),
});

const races = new RaceEngine({
  cloudModels: () => ["stub-cloud"],
  async runBranch(input) {
    fs.mkdirSync(path.join(input.worktreeDir, "app", "src"), { recursive: true });
    fs.writeFileSync(path.join(input.worktreeDir, "app", "src", "branch.ts"), "export const b = 1;\n", "utf8");
    return { ok: true, reportText: "branch built", usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0, credits: 1, wallMs: 5, toolCalls: 1 } };
  },
  async coverage() { return 8; },
  versions,
});

const devServerStub = {
  ensure: async () => "http://127.0.0.1:15173/",
  stop: () => {},
  stopApi: async () => {},
  status: (projectId: string) => ({ projectId, state: "stopped" as const, url: null, port: null, pid: null, startedAt: null, lastError: null }),
  logTail: () => [] as string[],
};

setAppRuntime({ engine, races, versions, devServer: devServerStub, verify: verifyStub });

const { handleAppBuilderRoutes } = await import("../routes/appBuilder.js");
const { ensureAppBuilderSchema } = await import("../../appbuilder/store.js");
ensureAppBuilderSchema();

interface Captured { status: number; body: unknown }

function fakeReq(method: string, body?: unknown): http.IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  req.method = method;
  req.headers = {};
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function fakeRes(): { res: http.ServerResponse; captured: Promise<Captured> } {
  const w = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as http.ServerResponse;
  let status = 0;
  const chunks: string[] = [];
  (w as unknown as { writeHead: (s: number, h?: unknown) => void }).writeHead = (s: number) => { status = s; return w; };
  (w as unknown as { setHeader: (k: string, v: string) => void }).setHeader = () => w;
  (w as unknown as { end: (d?: string | Buffer) => void }).end = (d?: string | Buffer) => {
    chunks.push(typeof d === "string" ? d : (d ?? "").toString());
    w.emit("close");
  };
  const captured = new Promise<Captured>((resolve) => {
    w.on("close", () => resolve({ status, body: chunks.length ? JSON.parse(chunks.join("")) : null }));
  });
  return { res: w, captured };
}

async function call(method: string, p: string, body?: unknown): Promise<Captured> {
  const { res, captured } = fakeRes();
  const full = new URL(`http://127.0.0.1:8787${p}`);
  // Real callers pass url.pathname as p, never the query string.
  const handled = await handleAppBuilderRoutes(fakeReq(method, body), res, full.pathname, full);
  assert.equal(handled, true, `${method} ${p} should be handled`);
  return captured;
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("router: outside prefix not handled", async () => {
  const { res } = fakeRes();
  assert.equal(await handleAppBuilderRoutes(fakeReq("GET"), res, "/api/other", new URL("http://x/api/other")), false);
});

test("router: projects CRUD with validation", async () => {
  const bad = await call("POST", "/api/app-projects", { title: "" });
  assert.equal(bad.status, 400);
  const created = await call("POST", "/api/app-projects", { title: "مشروع المسارات", description: "اختبار" });
  assert.equal(created.status, 200);
  const id = (created.body as { project: { id: string } }).project.id;
  assert.match(id, /^app_[a-z2-7]{12}$/);
  const list = await call("GET", "/api/app-projects");
  assert.equal((list.body as { projects: unknown[] }).projects.length, 1);
  const one = await call("GET", `/api/app-projects/${id}`);
  assert.equal((one.body as { queue: { items: unknown[] } }).queue.items.length, 0);
  const patched = await call("PATCH", `/api/app-projects/${id}`, { title: "اسم جديد" });
  assert.equal((patched.body as { project: { title: string } }).project.title, "اسم جديد");
  const badId = await call("GET", "/api/app-projects/app_bad");
  assert.equal(badId.status, 400);
  const missing = await call("GET", "/api/app-projects/app_aaaaaaaaaaaa");
  assert.equal(missing.status, 404);
  const wrongConfirm = await call("DELETE", `/api/app-projects/${id}`, { confirm: "nope" });
  assert.equal(wrongConfirm.status, 400);
});

test("router: queue + races estimate + usage + ai", async () => {
  const created = await call("POST", "/api/app-projects", { title: "q2" });
  const id = (created.body as { project: { id: string } }).project.id;
  const enq = await call("POST", `/api/app-projects/${id}/queue`, { content: "ابنِ صفحة", flavor: "quick" });
  assert.equal(enq.status, 200);
  const itemId = (enq.body as { item: { id: string } }).item.id;
  const moved = await call("PATCH", `/api/app-projects/${id}/queue/${itemId}`, { content: "معدّل" });
  assert.equal((moved.body as { queue: { items: Array<{ content: string }> } }).queue.items[0]!.content, "معدّل");
  const paused = await call("POST", `/api/app-projects/${id}/queue/pause`);
  assert.equal((paused.body as { queue: { paused: boolean } }).queue.paused, true);
  const whilePaused = await call("POST", `/api/app-projects/${id}/queue`, { content: "x" });
  assert.equal(whilePaused.status, 409);
  // resume would start the queued item through the engine pump (§4.11.2); remove it first
  const removed = await call("DELETE", `/api/app-projects/${id}/queue/${itemId}`);
  assert.equal((removed.body as { queue: { items: unknown[] } }).queue.items.length, 0);
  await call("POST", `/api/app-projects/${id}/queue/resume`);
  const est = await call("GET", `/api/app-projects/${id}/races/estimate?branches=3`);
  assert.equal((est.body as { estimate: { maxTotalCredits: number } }).estimate.maxTotalCredits, 45);
  const usage = await call("GET", `/api/app-projects/${id}/usage`);
  assert.equal((usage.body as { rows: unknown[] }).rows.length, 0, "no run started: the queue was empty on resume");
  const putAi = await call("PUT", `/api/app-projects/${id}/ai`, { dailyTokenCap: 5 });
  assert.equal(putAi.status, 400, "cap below the minimum");
  const putModel = await call("PUT", `/api/app-projects/${id}/ai`, { model: "gpt-x" });
  assert.equal(putModel.status, 200);
});

test("router: files tree/view/put with traversal refusal + stale detection + edit-session gate", async () => {
  const created = await call("POST", "/api/app-projects", { title: "files" });
  const id = (created.body as { project: { id: string; workspaceDir: string } }).project.id;
  const workspaceDir = (created.body as { project: { workspaceDir: string } }).project.workspaceDir;
  fs.writeFileSync(path.join(workspaceDir, "app", "index.html"), "<!doctype html>محتوى");
  fs.mkdirSync(path.join(workspaceDir, "app", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "app", "node_modules", "junk.js"), "x");
  const tree = await call("GET", `/api/app-projects/${id}/files`);
  const files = (tree.body as { files: string[] }).files;
  assert.deepEqual(files, ["index.html"], "node_modules excluded");
  const view = await call("GET", `/api/app-projects/${id}/files/view?path=index.html`);
  assert.equal((view.body as { content: string; sha1: string }).content, "<!doctype html>محتوى");
  assert.match((view.body as { sha1: string }).sha1, /^[0-9a-f]{40}$/);
  const escape = await call("GET", `/api/app-projects/${id}/files/view?path=../secrets.json`);
  assert.equal(escape.status, 404);
  // §4.15.2: PUT outside an edit session is 409 no_edit_session
  const noSession = await call("PUT", `/api/app-projects/${id}/files`, { path: "src/new.ts", content: "export {};" });
  assert.equal(noSession.status, 409);
  assert.equal((noSession.body as { error: string }).error, "no_edit_session");
  const open = await call("POST", `/api/app-projects/${id}/edit-session`, { action: "start" });
  assert.equal(open.status, 200);
  assert.equal((open.body as { project: { status: string } }).project.status, "editing");
  const put = await call("PUT", `/api/app-projects/${id}/files`, { path: "src/new.ts", content: "export {};", baseSha1: "deadbeef" });
  assert.equal(put.status, 200);
  const stale = await call("PUT", `/api/app-projects/${id}/files`, { path: "index.html", content: "new", baseSha1: "deadbeef" });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: string }).error, "stale_file");
  const search = await call("GET", `/api/app-projects/${id}/search?q=محتوى`);
  assert.deepEqual((search.body as { hits: Array<{ path: string }> }).hits.map((h) => h.path), ["index.html"]);
  // a run is refused while the edit session is open (409 edit_session_open)
  const runRefused = await call("POST", `/api/app-projects/${id}/runs`, { prompt: "x", flavor: "quick" });
  assert.equal(runRefused.status, 409);
  assert.equal((runRefused.body as { error: string }).error, "edit_session_open");
  // commit closes the session and creates the edit version
  const commit = await call("POST", `/api/app-projects/${id}/edit-session`, { action: "commit", message: "تعديل يدوي" });
  assert.equal(commit.status, 200);
  assert.equal((commit.body as { version: { source: string; title: string } }).version.source, "edit");
  assert.equal((commit.body as { version: { title: string } }).version.title, "تعديل يدوي");
  assert.equal((commit.body as { project: { status: string } }).project.status, "idle");
  const versionsList = await call("GET", `/api/app-projects/${id}/versions`);
  assert.equal((versionsList.body as { versions: unknown[] }).versions.length, 1);
});

test("router: runs + questions + plans + versions end to end (goal flavor, §4.15.2)", async () => {
  const created = await call("POST", "/api/app-projects", { title: "goal-route" });
  const id = (created.body as { project: { id: string } }).project.id;
  const project = getAppProject(id)!;

  const started = await call("POST", `/api/app-projects/${id}/runs`, { prompt: "تطبيق صغير", flavor: "goal" });
  assert.equal(started.status, 200);
  const runId = (started.body as { runId: string }).runId;
  assert.match(runId, /^run_/);

  // questions card pause (§4.2.1): answer through the route contract
  await waitFor("questions card", () => listQuestionCards(id).some((c) => c.status === "pending"));
  const card = listQuestionCards(id).find((c) => c.status === "pending")!;
  const badAnswer = await call("POST", `/api/app-projects/${id}/questions/${card.id}`, { answers: [{ questionId: "q1", optionIds: ["nope"] }] });
  assert.equal(badAnswer.status, 400);
  const answered = await call("POST", `/api/app-projects/${id}/questions/${card.id}`, { answers: [{ questionId: "q1", optionIds: ["o2"] }] });
  assert.equal(answered.status, 200);
  assert.equal((answered.body as { card: { status: string } }).card.status, "answered");

  // plan approval with the stale-revision 409 (§4.2.2 rule 3)
  await waitFor("plan draft", () => latestPlanDraft(id)?.status === "draft");
  const drafts = await call("GET", `/api/app-projects/${id}/plans`);
  const draftId = (drafts.body as { drafts: Array<{ id: string; revision: number; status: string }> }).drafts[0]!.id;
  const stale = await call("POST", `/api/app-projects/${id}/plans/${draftId}/decision`, { decision: "approve", revision: 99 });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: string; latest: number }).error, "stale_revision");
  assert.equal((stale.body as { latest: number }).latest, 1);
  const approved = await call("POST", `/api/app-projects/${id}/plans/${draftId}/decision`, { decision: "approve", revision: 1 });
  assert.equal(approved.status, 200);
  assert.equal((approved.body as { draft: { status: string } }).draft.status, "approved");

  await waitFor("run done", () => getRun(runId)?.status === "done");
  assert.equal(getRun(runId)!.status, "done");
  // the build version exists and the assignments are visible
  const versions = await call("GET", `/api/app-projects/${id}/versions`);
  assert.equal((versions.body as { versions: Array<{ source: string }> }).versions[0]!.source, "build");
  const assignments = await call("GET", `/api/app-projects/${id}/assignments`);
  assert.equal((assignments.body as { assignments: Array<{ status: string }> }).assignments[0]!.status, "done");
  const reports = await call("GET", `/api/app-projects/${id}/verify-reports`);
  assert.equal((reports.body as { reports: unknown[] }).reports.length, 1);

  // stop is a no-op after the run finished
  const stop = await call("POST", `/api/app-projects/${id}/runs/${runId}/stop`);
  assert.equal(stop.status, 200);
  assert.equal((stop.body as { ok: boolean; stopped: boolean }).stopped, false);

  // PATCH the version title; diff against the previous (nonexistent) version number is refused
  const first = (versions.body as { versions: Array<{ number: number }> }).versions[0]!.number;
  const renamed = await call("PATCH", `/api/app-projects/${id}/versions/${first}`, { title: "عنوان جديد" });
  assert.equal((renamed.body as { version: { title: string } }).version.title, "عنوان جديد");
  const badVersion = await call("GET", `/api/app-projects/${id}/versions/99/diff?from=1`);
  assert.equal(badVersion.status, 404);
  const fileAt = await call("GET", `/api/app-projects/${id}/versions/${first}/file?path=app/src/pages/Index.tsx`);
  assert.ok((fileAt.body as { content: string }).content.includes("Index"), "file content readable at the version");
  const forks = await call("GET", `/api/app-projects/${id}/versions/${first}/forks`);
  assert.equal((forks.body as { projects: unknown[] }).projects.length, 0);
});

test("router: quick run queues while a run is active, then runs", async () => {
  const created = await call("POST", "/api/app-projects", { title: "queue-route" });
  const id = (created.body as { project: { id: string } }).project.id;
  const first = await call("POST", `/api/app-projects/${id}/runs`, { prompt: "الأولى", flavor: "quick" });
  const run1 = (first.body as { runId: string }).runId;
  await waitFor("run1 active", () => getRun(run1)?.status !== undefined && engine.activeRunFor(id) !== undefined);
  const queued = await call("POST", `/api/app-projects/${id}/runs`, { prompt: "الثانية", flavor: "quick" });
  assert.equal(queued.status, 200);
  assert.ok("queued" in (queued.body as object), `second queues, got ${JSON.stringify(queued.body)}`);
  await waitFor("run1 done", () => getRun(run1)?.status === "done");
  // the pump starts the queued prompt (§4.11.2)
  await waitFor("second run done", () => {
    const others = listRuns(id).filter((r) => r.id !== run1 && r.raceId === null);
    return others.length === 1 && others[0]!.status === "done";
  }, 12_000);
});

test("router: races start via POST /runs (quick only), choose through the route", async () => {
  const goal = await call("POST", "/api/app-projects", { title: "race-goal" });
  const goalId = (goal.body as { project: { id: string } }).project.id;
  const refused = await call("POST", `/api/app-projects/${goalId}/runs`, { prompt: "x", flavor: "goal", race: { branches: 2 } });
  assert.equal(refused.status, 409);
  assert.equal((refused.body as { error: string }).error, "queue_incompatible");

  const created = await call("POST", "/api/app-projects", { title: "race-route" });
  const id = (created.body as { project: { id: string } }).project.id;
  // seed the repo so the race has a base commit
  const project = getAppProject(id)!;
  await scaffoldStub(project);
  await versions.snapshot(project, { title: "Seed", summary: "s", source: "build", usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, credits: 0, wallMs: 0, toolCalls: 0 } });
  const started = await call("POST", `/api/app-projects/${id}/runs`, { prompt: "سابق", flavor: "quick", race: { branches: 2 } });
  assert.equal(started.status, 200);
  const raceId = (started.body as { race: { id: string } }).race.id;
  await waitFor("choosing", () => getRace(raceId)?.status === "choosing");
  const racesList = await call("GET", `/api/app-projects/${id}/races`);
  const race = (racesList.body as { races: Array<{ id: string; branches: Array<{ id: string; status: string }> }> }).races[0]!;
  const chosen = await call("POST", `/api/app-projects/${id}/races/${race.id}/choose`, { branchId: race.branches[0]!.id });
  assert.equal(chosen.status, 200);
  assert.equal((chosen.body as { version: { source: string } | null }).version!.source, "race");
  // a second race of the same project right after promotion is allowed; abort it through the route
  const again = await call("POST", `/api/app-projects/${id}/runs`, { prompt: "سابق ثانية", flavor: "quick", race: { branches: 2 } });
  assert.equal(again.status, 200);
  const secondRaceId = (again.body as { race: { id: string } }).race.id;
  await waitFor("second race live", () => (getRace(secondRaceId)?.branches.length ?? 0) === 2);
  const aborted = await call("POST", `/api/app-projects/${id}/races/${secondRaceId}/abort`);
  assert.equal(aborted.status, 200);
  assert.equal((aborted.body as { race: { status: string } }).race.status, "aborted");
});

test("router: design text-edit applies directly or returns the prompt", async () => {
  const created = await call("POST", "/api/app-projects", { title: "textedit" });
  const body = created.body as { project: { id: string; workspaceDir: string } };
  const id = body.project.id;
  const workspaceDir = body.project.workspaceDir;
  const index = path.join(workspaceDir, "app", "src", "pages", "Index.tsx");
  fs.mkdirSync(path.dirname(index), { recursive: true });
  fs.writeFileSync(index, "export default function Index() {\n  return <main>Track every riyal</main>;\n}\n", "utf8");
  const applied = await call("POST", `/api/app-projects/${id}/design/text-edit`, { src: "src/pages/Index.tsx:2:11", before: "Track every riyal", after: "Know every riyal" });
  assert.equal(applied.status, 200);
  assert.equal((applied.body as { status: string }).status, "applied");
  assert.ok(fs.readFileSync(index, "utf8").includes("Know every riyal"));
  assert.ok(!("prompt" in (applied.body as object)), "no prompt when applied");
  const unsafe = await call("POST", `/api/app-projects/${id}/design/text-edit`, { src: "src/pages/Index.tsx:2:11", before: "x", after: "{evil}" });
  assert.equal((unsafe.body as { status: string; prompt?: string }).status, "bad_input");
  assert.ok((unsafe.body as { prompt?: string }).prompt, "the composer prompt comes back");
});

test("router: runtime errors + later-wave areas + preflight", async () => {
  const created = await call("POST", "/api/app-projects", { title: "err" });
  const id = (created.body as { project: { id: string } }).project.id;
  const errors = await call("GET", `/api/app-projects/${id}/runtime-errors`);
  assert.equal((errors.body as { errors: unknown[] }).errors.length, 0);
  // §4.10/§4.9 surfaces are the remaining later-wave areas
  const db = await call("GET", `/api/app-projects/${id}/db/collections`);
  assert.equal(db.status, 501);
  assert.equal((db.body as { error: string }).error, "engine_pending");
  const run = await call("POST", `/api/app-projects/${id}/runs`, {});
  assert.equal(run.status, 400, "empty prompt refused");
  const pre = await call("GET", "/api/app-projects/preflight");
  assert.equal((pre.body as { preflight: { ok: boolean; items: unknown[] } }).preflight.items.length > 0, true);
});
