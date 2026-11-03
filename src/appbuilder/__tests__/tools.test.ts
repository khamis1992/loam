// src/appbuilder/__tests__/tools.test.ts — W3-b: the app_* agent tools of
// MISSING §4.2.4/§4.3.9/§4.5.3/§4.6.6-§4.6.7 — task create/finish happy path,
// app_verify wiring, app_db_query containment, the npm shell_run allowlist of
// the role scope gate, and the dependency add/junction rules. npm and the model
// are mocked; everything else runs on temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Tool, ToolContext } from "../../tools/registry.js";
import type { RoleGateRegistry } from "../roles.js";
import type { AppProject, VerifyReport } from "../types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-abtools-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const toolsMod = await import("../tools.js");
const lead = await import("../lead.js");
const roles = await import("../roles.js");
const { createAppProject, getAppProject } = await import("../projects.js");
const { insertRun, latestVerifyReportForRun } = await import("../store.js");

function ctxFor(project: AppProject): ToolContext {
  return {
    cfg: {} as ToolContext["cfg"],
    workspace: project.workspaceDir,
    emit: (() => {}) as ToolContext["emit"],
    taskId: project.taskId,
  };
}

function tool(name: string): Tool {
  const t = toolsMod.createAppBuilderTools().find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function planDoc(title: string): import("../types.js").PlanDocument {
  return {
    title,
    overview: "One sentence overview.",
    scenario: "web_app",
    templateId: "web-app",
    features: [],
    keyDecisions: [{ date: "2026-10-29", decision: "No accounts", rationale: "default: user did not say", source: "default" }],
    constraints: [],
    requirements: ["Shows a list"],
    userStories: [],
    tasks: [{ id: "T1", title: "Build the list", role: "engineer", deps: [], status: "pending", acceptance: ["List renders"] }],
  };
}

function approvePlanFor(project: AppProject): void {
  const run = insertRun({ projectId: project.id, flavor: "goal", prompt: "p" });
  lead.createPlanDraft(project, run.id, planDoc(`${project.title} plan`));
  const r = lead.approvePlanDraft(project, 1);
  assert.equal(r.ok, true, "test setup: plan approved");
}

// ---------- app_task_create / app_task_finish ----------

test("app_task_create + app_task_finish happy path; create refuses before approval", async () => {
  const project = createAppProject({ title: "task-tools", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "goal", prompt: "p" });
  toolsMod.setActiveAppBuild({ project, runId: run.id });
  const ctx = ctxFor(project);
  const brief = "Build the whole list feature end to end, keep it inside app/src, verify with app_verify, and report what you checked.";

  const early = await tool("app_task_create").run({ role: "engineer", planTaskIds: ["T1"], brief }, ctx);
  assert.equal(early.ok, false);
  assert.ok(early.content.includes("plan not approved"));

  approvePlanFor(project);
  const created = await tool("app_task_create").run({ role: "engineer", planTaskIds: ["T1"], brief }, ctx);
  assert.equal(created.ok, true, created.content);
  const { assignmentId } = JSON.parse(created.content) as { assignmentId: string };
  assert.match(assignmentId, /^as_[a-z2-7]{12}$/);

  const shortBrief = await tool("app_task_create").run({ role: "engineer", planTaskIds: ["T1"], brief: "too short" }, ctx);
  assert.equal(shortBrief.ok, false, "brief minLength 80 is enforced");

  const finished = await tool("app_task_finish").run({ assignmentId, outcome: "done", summary: "Built the list and verified it with app_verify." }, ctx);
  assert.equal(finished.ok, true, finished.content);
  const finishedAgain = await tool("app_task_finish").run({ assignmentId, outcome: "done", summary: "Built the list and verified it with app_verify." }, ctx);
  assert.equal(finishedAgain.ok, false, "an assignment finishes once");
  toolsMod.clearAppBuild(project.taskId);
});

test("app tools refuse outside an App Builder run", async () => {
  const project = createAppProject({ title: "no-run", baseWorkspace: tmp });
  const ctx = ctxFor(project); // no setActiveAppBuild for this project's task
  const r = await tool("app_task_create").run({ role: "engineer", planTaskIds: ["T1"], brief: "x".repeat(80) }, ctx);
  assert.equal(r.ok, false);
  assert.ok(r.content.includes("App Builder run"));
});

// ---------- app_verify wiring ----------

function fakeReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    id: "vr_" + "a".repeat(12),
    projectId: "p",
    runId: "r",
    attempt: 1,
    tier: "standard",
    pass: false,
    steps: [{ id: "check", command: "npm run check", ok: true, skipped: false, durationMs: 5, exitCode: 0, outputTail: "" }],
    consoleErrors: 0,
    screenshots: [],
    visualVerdict: "skipped",
    visualNotes: "",
    logPath: path.join(tmp, "vr.log"),
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("resolveVerifyTier: strict from settings, fast for quick runs with a version, raise-only", () => {
  const base = { defaultTier: "auto" as const, raceBranches: 2 as const, verifyTier: "standard" as const, devServerPort: null };
  assert.equal(toolsMod.resolveVerifyTier({ settings: base } as AppProject, "goal"), "standard");
  assert.equal(toolsMod.resolveVerifyTier({ settings: base, activeVersion: 3 } as AppProject, "quick"), "fast");
  assert.equal(toolsMod.resolveVerifyTier({ settings: base, activeVersion: 3 } as AppProject, "quick", "standard"), "standard", "the model can raise");
  assert.equal(toolsMod.resolveVerifyTier({ settings: base, activeVersion: 3 } as AppProject, "quick", "strict"), "strict");
  assert.equal(toolsMod.resolveVerifyTier({ settings: base } as AppProject, "goal", "fast"), "standard", "the model cannot lower");
  assert.equal(toolsMod.resolveVerifyTier({ settings: { ...base, verifyTier: "strict" } } as AppProject, "quick", "fast"), "strict", "settings strict wins");
});

test("app_verify: runs the bound verify runner, stores the report, writes the PROGRESS verification line", async () => {
  const project = createAppProject({ title: "verify-tool", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "goal", prompt: "p" });
  const seen: unknown[] = [];
  toolsMod.setActiveAppBuild({
    project,
    runId: run.id,
    verify: {
      async run(o) {
        seen.push(o);
        return fakeReport({ projectId: project.id, runId: run.id, pass: true });
      },
      endRun() {},
    },
  });
  const r = await tool("app_verify").run({}, ctxFor(project));
  assert.equal(r.ok, true, r.content);
  assert.ok(r.content.startsWith("app_verify PASSED"));
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { tier: VerifyReport["tier"] }).tier, "standard", "goal run defaults to standard");
  const stored = latestVerifyReportForRun(run.id);
  assert.ok(stored, "the report row is stored");
  assert.equal(stored!.pass, true);
  const progress = fs.readFileSync(path.join(project.workspaceDir, ".loam", "context", "PROGRESS.md"), "utf8");
  assert.match(progress, /Latest: v1 pass on \d{4}-\d{2}-\d{2}\. check ok\. Not verified: /);
  toolsMod.clearAppBuild(project.taskId);
});

test("app_verify without a bound verify runner refuses instead of pretending", async () => {
  const project = createAppProject({ title: "verify-norun", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "quick", prompt: "p" });
  toolsMod.setActiveAppBuild({ project, runId: run.id });
  const r = await tool("app_verify").run({}, ctxFor(project));
  assert.equal(r.ok, false);
  toolsMod.clearAppBuild(project.taskId);
});

// ---------- app_db_query containment ----------

test("app_db_query: read-only, SELECT/WITH only, one statement, 50-row cap", async () => {
  const project = createAppProject({ title: "db-tool", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "quick", prompt: "p" });
  toolsMod.setActiveAppBuild({ project, runId: run.id });
  const dbFile = path.join(project.workspaceDir, "app", "data", "app.sqlite");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
  for (let i = 0; i < 60; i++) insert.run(`row-${i}`);
  db.close();

  const ctx = ctxFor(project);
  const rows = await tool("app_db_query").run({ sql: "SELECT * FROM t ORDER BY id" }, ctx);
  assert.equal(rows.ok, true);
  const parsed = JSON.parse((JSON.parse(rows.content) as { rows: string }).rows) as unknown[];
  assert.equal(parsed.length, 50, "result capped at 50 rows");

  const withCte = await tool("app_db_query").run({ sql: "WITH x AS (SELECT 1 AS one) SELECT one FROM x" }, ctx);
  assert.equal(withCte.ok, true);

  for (const sql of ["INSERT INTO t (name) VALUES ('x')", "DELETE FROM t", "UPDATE t SET name = 'x'", "DROP TABLE t", "SELECT 1; DROP TABLE t", "SELECT * FROM t; SELECT 2"]) {
    const blocked = await tool("app_db_query").run({ sql }, ctx);
    assert.equal(blocked.ok, false, sql);
    assert.ok(blocked.content.includes("select_only"), `${sql} → select_only`);
  }
  const trailing = await tool("app_db_query").run({ sql: "SELECT COUNT(*) AS n FROM t;" }, ctx);
  assert.equal(trailing.ok, true, "a single trailing semicolon is fine");
  const commented = await tool("app_db_query").run({ sql: "-- comment\nSELECT 1 AS one" }, ctx);
  assert.equal(commented.ok, true, "comments in front of a SELECT are stripped, not fatal");

  const noDb = createAppProject({ title: "db-none", baseWorkspace: tmp });
  const noDbRun = insertRun({ projectId: noDb.id, flavor: "quick", prompt: "p" });
  toolsMod.setActiveAppBuild({ project: noDb, runId: noDbRun.id });
  const missing = await tool("app_db_query").run({ sql: "SELECT 1" }, ctxFor(noDb));
  assert.equal(missing.ok, false);
  assert.ok(missing.content.includes("no_database"));
  toolsMod.clearAppBuild(project.taskId);
  toolsMod.clearAppBuild(noDb.taskId);
});

// ---------- the §4.3.9 / §4.6.2 shell_run blocks in applyRoleScopeGate ----------

class MiniRegistry implements RoleGateRegistry {
  private map = new Map<string, Tool>();
  names(): string[] { return [...this.map.keys()]; }
  get(name: string): Tool | undefined { return this.map.get(name); }
  replaceTool(t: Tool): void { this.map.set(t.name, t); }
  register(t: Tool): void { this.map.set(t.name, t); }
}

function gatedRegistry(): MiniRegistry {
  const reg = new MiniRegistry();
  reg.register({ name: "shell_run", description: "", parameters: {}, async run(args) { return { ok: true, content: `ran ${String(args.command)}` }; } });
  reg.register({ name: "file_write", description: "", parameters: {}, async run(args) { return { ok: true, content: `wrote ${String(args.path)}` }; } });
  roles.applyRoleScopeGate(reg, () => "engineer");
  return reg;
}

test("role scope gate: npm install/add and npm run verify scripts are blocked with the spec's exact messages", async () => {
  const reg = gatedRegistry();
  const ctx = ctxFor({ taskId: "t" } as AppProject);
  const install = await reg.get("shell_run")!.run({ command: "npm install lodash" }, ctx);
  assert.equal(install.ok, false);
  assert.equal(install.content, "Use app_add_dependency to add a package.");
  const pnpmAdd = await reg.get("shell_run")!.run({ command: "pnpm add gsap" }, ctx);
  assert.equal(pnpmAdd.content, "Use app_add_dependency to add a package.");
  const yarnI = await reg.get("shell_run")!.run({ command: "yarn i marked" }, ctx);
  assert.equal(yarnI.content, "Use app_add_dependency to add a package.");
  for (const script of ["npm run build", "npm run lint", "npm run check", "npm run typecheck"]) {
    const blocked = await reg.get("shell_run")!.run({ command: script }, ctx);
    assert.equal(blocked.ok, false, script);
    assert.equal(blocked.content, "Use app_verify. It runs check, lint, typecheck and build in one call.");
  }
  const allowed = await reg.get("shell_run")!.run({ command: "git status" }, ctx);
  assert.equal(allowed.ok, true, "unrelated commands pass through");
  const write = await reg.get("file_write")!.run({ path: "app/src/lib/util.ts" }, ctx);
  assert.equal(write.ok, true, "the write-scope gate still lets the Engineer write app/**");
  const refused = await reg.get("file_write")!.run({ path: "outside/x.ts" }, ctx);
  assert.equal(refused.ok, false);
  assert.equal(refused.content, "Role Engineer may not write outside/x.ts. Hand this to the Engineer.");
});

// ---------- app_add_dependency (§4.3.9) ----------

function fakeDeps(license: string, install: (appDir: string, spec: string) => number) {
  return {
    npmViewLicense: async () => JSON.stringify(license),
    npmInstall: async (appDir: string, spec: string) => install(appDir, spec),
  };
}

function writeAppPackageJson(project: AppProject, dependencies: Record<string, string> = {}): void {
  const appDir = path.join(project.workspaceDir, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify({ name: "loam-web-app", private: true, dependencies }, null, 2)}\n`, "utf8");
}

test("app_add_dependency: satisfying version in the shared folder updates package.json only, no install", async () => {
  const project = createAppProject({ title: "dep-shared", baseWorkspace: tmp });
  writeAppPackageJson(project);
  const { depsDirFor } = await import("../depsCache.js");
  const shared = depsDirFor(project);
  fs.mkdirSync(path.join(shared, "node_modules", "marked", "lib"), { recursive: true });
  fs.writeFileSync(path.join(shared, "node_modules", "marked", "package.json"), JSON.stringify({ name: "marked", version: "15.0.0" }), "utf8");
  const run = insertRun({ projectId: project.id, flavor: "quick", prompt: "p" });
  const ctx = { project, runId: run.id };
  let installCalls = 0;
  const r = await toolsMod.addDependency(ctx, { name: "marked", range: "^15" }, fakeDeps("MIT", () => { installCalls += 1; return 0; }));
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  assert.equal(installCalls, 0, "no install when the shared folder already satisfies the range");
  assert.equal(r.depsMode, "shared");
  assert.equal(r.installed, false);
  const pkg = JSON.parse(fs.readFileSync(path.join(project.workspaceDir, "app", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.marked, "^15.0.0");
  assert.equal(getAppProject(project.id)!.depsMode, "shared");
  assert.deepEqual(toolsMod.takeAddedPackages(run.id), [{ name: "marked", version: "15.0.0", license: "MIT", licenseInNoteList: true }]);
  assert.equal(toolsMod.takeAddedPackages(run.id).length, 0, "take clears the list");
});

test("app_add_dependency: leaves the shared folder — junction unlinked (never the target), own install, licence note", async () => {
  const project = createAppProject({ title: "dep-own", baseWorkspace: tmp });
  writeAppPackageJson(project);
  const { depsDirFor } = await import("../depsCache.js");
  const sharedNodeModules = path.join(depsDirFor(project), "node_modules");
  fs.mkdirSync(sharedNodeModules, { recursive: true });
  fs.writeFileSync(path.join(sharedNodeModules, "marker.txt"), "shared folder file", "utf8");
  const appDir = path.join(project.workspaceDir, "app");
  fs.symlinkSync(sharedNodeModules, path.join(appDir, "node_modules"), "junction");

  const run = insertRun({ projectId: project.id, flavor: "quick", prompt: "p" });
  const specs: string[] = [];
  const deps = fakeDeps("GPL-3.0", (dir, spec) => {
    specs.push(spec);
    assert.equal(dir, appDir, "install runs in app/");
    // npm's effect: a real node_modules appears with the new package inside.
    fs.mkdirSync(path.join(appDir, "node_modules", "left-pad", "lib"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: "1.3.0" }), "utf8");
    return 0;
  });
  const r = await toolsMod.addDependency({ project, runId: run.id }, { name: "left-pad" }, deps);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  assert.deepEqual(specs, ["left-pad@latest"]);
  assert.equal(r.depsMode, "own");
  assert.equal(r.installed, true);
  assert.equal(r.license, "GPL-3.0");
  assert.equal(r.licenceNote, "Package licence to review: left-pad (GPL-3.0)", "licence returned as a note, never a block");
  // The junction was removed with unlink only: the target folder still has its
  // file, and app/node_modules is now a real folder without it.
  assert.ok(fs.existsSync(path.join(sharedNodeModules, "marker.txt")), "the shared folder is untouched");
  assert.ok(!fs.existsSync(path.join(appDir, "node_modules", "marker.txt")), "the junction is gone (not the target's files)");
  assert.ok(fs.existsSync(path.join(appDir, "node_modules", "left-pad", "package.json")));
  assert.equal(getAppProject(project.id)!.depsMode, "own");
  assert.equal(toolsMod.takeAddedPackages(run.id)[0]!.licenseInNoteList, false);
});

test("app_add_dependency: own mode never removes the real node_modules; failed install reports; bad input rejected", async () => {
  const project = createAppProject({ title: "dep-own2", baseWorkspace: tmp });
  writeAppPackageJson(project, { react: "^19.0.0" });
  const appDir = path.join(project.workspaceDir, "app");
  fs.mkdirSync(path.join(appDir, "node_modules", "react"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "node_modules", "react", "package.json"), JSON.stringify({ name: "react", version: "19.2.0" }), "utf8");
  const { updateAppProjectRow } = await import("../store.js");
  updateAppProjectRow(project.id, { depsMode: "own" });

  const run = insertRun({ projectId: project.id, flavor: "quick", prompt: "p" });
  const r = await toolsMod.addDependency({ project: getAppProject(project.id)!, runId: run.id }, { name: "clsx" }, fakeDeps("MIT", (dir) => {
    fs.mkdirSync(path.join(dir, "node_modules", "clsx"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "clsx", "package.json"), JSON.stringify({ name: "clsx", version: "2.1.1" }), "utf8");
    return 0;
  }));
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(appDir, "node_modules", "react", "package.json")), "own mode keeps the existing node_modules");

  const failed = await toolsMod.addDependency({ project: getAppProject(project.id)!, runId: run.id }, { name: "breaks" }, fakeDeps("MIT", () => 1));
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /deps_install_failed/);

  const badName = await toolsMod.addDependency({ project, runId: run.id }, { name: "NOT VALID" }, fakeDeps("MIT", () => 0));
  assert.equal(badName.ok, false);
  const badRange = await toolsMod.addDependency({ project, runId: run.id }, { name: "ok", range: "banana" }, fakeDeps("MIT", () => 0));
  assert.equal(badRange.ok, false);
});

// ---------- app_version_note + app_context_write ----------

test("app_version_note stores the note for the version step; app_context_write refuses ## Verification", async () => {
  const project = createAppProject({ title: "note-tool", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "quick", prompt: "p" });
  toolsMod.setActiveAppBuild({ project, runId: run.id });
  const ctx = ctxFor(project);
  const note = await tool("app_version_note").run({ title: "First working build", summary: "The list works and saves items." }, ctx);
  assert.equal(note.ok, true, note.content);
  assert.deepEqual(toolsMod.takeVersionNote(run.id), { title: "First working build", summary: "The list works and saves items." });
  assert.equal(toolsMod.takeVersionNote(run.id), undefined, "take clears the note");

  const write = await tool("app_context_write").run({ updates: [{ file: "PROJECT", heading: "## Overview", body: "A small timer app." }] }, ctx);
  assert.equal(write.ok, true, write.content);
  const projectMd = fs.readFileSync(path.join(project.workspaceDir, ".loam", "context", "PROJECT.md"), "utf8");
  assert.ok(projectMd.includes("A small timer app."));

  const refused = await tool("app_context_write").run({ updates: [{ file: "PROGRESS", heading: "## Verification", body: "tampered" }] }, ctx);
  assert.equal(refused.ok, false);
  assert.ok(refused.content.includes("app_verify"));
  toolsMod.clearAppBuild(project.taskId);
});
