// src/appbuilder/tools.ts — the App Builder agent tools (MISSING §4.2.4,
// §4.5.3, §4.6.6, §4.6.7, §4.3.9). Handlers resolve the attached App project
// through the active-build binding (set by the run engine at run start) and
// delegate every row mutation to store.ts / lead.ts — nothing here owns SQL.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Tool, ToolResult } from "../tools/registry.js";
import { applyContextUpdates, writeVerificationSummary } from "./contextFiles.js";
import { depsDirFor } from "./depsCache.js";
import { emitProjectEvent } from "./events.js";
import { createAssignmentForPlan, finishAssignmentForPlan } from "./lead.js";
import { appProcessEnv } from "./processEnv.js";
import { getRun, insertVerifyReport, updateAppProjectRow } from "./store.js";
import { formatVerifyReportForModel, TIER_STEPS } from "./verifyLoop.js";
import type { AppProject, AppRoleId, VerifyReport, VerifyTier } from "./types.js";

// ----------------------------------------------------------------------------
// Active build binding: the engine (W3-c) sets this at run start; handlers
// resolve the attached project through ctx.taskId (the project's Loam task id).
// ----------------------------------------------------------------------------

/** The VerifyLoop surface the tool needs; `VerifyLoop` satisfies it structurally. */
export interface VerifyRunner {
  run(o: { project: AppProject; runId: string; tier?: VerifyTier; signal?: AbortSignal }): Promise<VerifyReport>;
  endRun(runId: string): void;
}

export interface AppBuildContext {
  project: AppProject;
  runId: string;
  /** VerifyLoop bound to this run's deps (dev server, visual reviewer, contract). */
  verify?: VerifyRunner;
}

const activeBuilds = new Map<string, AppBuildContext>(); // key: project.taskId

export function setActiveAppBuild(ctx: AppBuildContext): void {
  activeBuilds.set(ctx.project.taskId, ctx);
}

export function clearAppBuild(taskId: string): void {
  activeBuilds.delete(taskId);
}

export function activeAppBuildFor(taskId: string | undefined): AppBuildContext | undefined {
  return taskId ? activeBuilds.get(taskId) : undefined;
}

function noRun(): ToolResult {
  return { ok: false, content: "This tool works only inside an App Builder run with an App project attached." };
}

// ----------------------------------------------------------------------------
// Per-run side channels: version note (§4.6.7) and added packages (§4.3.9)
// ----------------------------------------------------------------------------

const versionNotes = new Map<string, { title: string; summary: string }>();

/** app_version_note stores the note here; the version step takes it (and skips the VERSION_TITLE_SYSTEM call). */
export function setVersionNote(runId: string, note: { title: string; summary: string }): void {
  versionNotes.set(runId, note);
}

/** Take (and clear) the run's note. Returns undefined when the model never left one. */
export function takeVersionNote(runId: string): { title: string; summary: string } | undefined {
  const note = versionNotes.get(runId);
  versionNotes.delete(runId);
  return note;
}

const addedPackagesByRun = new Map<string, Array<{ name: string; version: string; license: string; licenseInNoteList: boolean }>>();

/** Appends one §4.3.9 record; snapshot() stores the list in app_versions.added_packages. */
export function recordAddedPackage(runId: string, pkg: { name: string; version: string; license: string; licenseInNoteList: boolean }): void {
  const list = addedPackagesByRun.get(runId) ?? [];
  list.push(pkg);
  addedPackagesByRun.set(runId, list);
}

/** Take (and clear) the run's added-package list for the version snapshot. */
export function takeAddedPackages(runId: string): Array<{ name: string; version: string; license: string; licenseInNoteList: boolean }> {
  const list = addedPackagesByRun.get(runId) ?? [];
  addedPackagesByRun.delete(runId);
  return list;
}

// ----------------------------------------------------------------------------
// app_verify tier selection (§4.6.2 OD-2): strict from settings, else fast for
// a quick run on a project that already has a version, else standard. The
// model's argument can only raise the tier, never lower it.
// ----------------------------------------------------------------------------

const TIER_ORDER: VerifyTier[] = ["fast", "standard", "strict"];

export function resolveVerifyTier(project: AppProject, flavor: "quick" | "goal", requested?: VerifyTier): VerifyTier {
  const base: VerifyTier =
    project.settings.verifyTier === "strict" ? "strict"
    : flavor === "quick" && project.activeVersion !== null ? "fast"
    : "standard";
  if (!requested) return base;
  return TIER_ORDER.indexOf(requested) > TIER_ORDER.indexOf(base) ? requested : base;
}

/** The §4.5.2 "## Verification" line app_verify writes to PROGRESS.md (§4.6.8). */
export function verificationSummaryLine(report: VerifyReport, project: AppProject): string {
  const day = new Date().toISOString().slice(0, 10);
  const parts = report.steps
    .filter((s) => s.id !== "install" && s.id !== "visual")
    .map((s) => `${s.id} ${s.ok ? (s.skipped ? "skip" : "ok") : "fail"}`);
  const missing = TIER_STEPS[report.tier].filter((id) => !report.steps.some((s) => s.id === id));
  const v = `v${(project.activeVersion ?? 0) + 1}`;
  return `Latest: ${v} ${report.pass ? "pass" : "fail"} on ${day}. ${parts.join(", ")}. Not verified: ${missing.length > 0 ? missing.join(", ") : "none"}.`;
}

// ----------------------------------------------------------------------------
// app_db_query containment (§4.6.7)
// ----------------------------------------------------------------------------

const MAX_ROWS = 50;
const MAX_JSON_CHARS = 8_000;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

export type DbQueryResult =
  | { ok: true; rows: unknown[]; truncated: boolean }
  | { ok: false; error: "no_database" | "select_only" | "db_error"; message?: string };

/** Read-only SELECT/WITH against app/data/app.sqlite; SQLite itself refuses writes via {readOnly: true}. */
export function appDbQueryFile(dbFile: string, sqlRaw: string): DbQueryResult {
  if (!fs.existsSync(dbFile)) return { ok: false, error: "no_database" };
  const sql = stripSqlComments(sqlRaw).trim();
  const head = /^((select|with)\b)/i.test(sql.replace(/^\(/, ""));
  if (!head) return { ok: false, error: "select_only" };
  // Any ';' followed by more text is a second statement — refuse it.
  const firstSemi = sql.indexOf(";");
  if (firstSemi >= 0 && sql.slice(firstSemi + 1).trim().length > 0) return { ok: false, error: "select_only" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const stmt = db.prepare(sql.replace(/;\s*$/, ""));
    const all = (stmt.all() as unknown[]).slice(0, MAX_ROWS);
    return { ok: true, rows: all, truncated: all.length === MAX_ROWS };
  } catch (err) {
    return { ok: false, error: "db_error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// ----------------------------------------------------------------------------
// app_add_dependency (§4.3.9): no package count limit, licence returned as a
// note, junction removed with fs.unlinkSync only, npm install with
// --ignore-scripts keeping app/package-lock.json.
// ----------------------------------------------------------------------------

const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const RANGE_RE = /^(latest|\*|(\^|~|>=|<=|>|<|=)?\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?)$/;
const OK_LICENCES = new Set([
  "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unlicense",
  "MPL-2.0", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0",
]);
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

export interface AppBuilderToolDeps {
  /** `npm view <name>@<range> license --json`. Returns the raw stdout or null. */
  npmViewLicense?: (name: string, range: string) => Promise<string | null>;
  /** The §4.3.9 install (`npm install --prefer-offline --no-audit --no-fund --ignore-scripts <spec>`) in app/. Returns the exit code. */
  npmInstall?: (appDir: string, spec: string, env: Record<string, string>) => Promise<number>;
}

function runNpm(args: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number; output: string }> {
  // With a scrubbed env, keep only the Windows essentials npm.cmd itself needs.
  const windowsKeep: Record<string, string | undefined> = process.platform === "win32"
    ? Object.fromEntries(["SystemRoot", "ComSpec", "windir", "PATHEXT", "PATH"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
    : {};
  return new Promise((resolve) => {
    const child = spawn(NPM, args, { cwd, windowsHide: true, shell: process.platform === "win32", env: env ? { ...windowsKeep, ...env } : process.env });
    let output = "";
    const feed = (b: Buffer) => { output += b.toString("utf8"); };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", () => resolve({ code: 1, output: `${output}\n[loam] failed to start npm` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

const defaultDeps: Required<AppBuilderToolDeps> = {
  async npmViewLicense(name, range) {
    const r = await runNpm(["view", `${name}@${range}`, "license", "--json"], process.cwd());
    return r.code === 0 ? r.output.trim() : null;
  },
  async npmInstall(appDir, spec, env) {
    const r = await runNpm(["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", spec], appDir, env);
    return r.code;
  },
};

function parseLicense(viewOutput: string | null): string {
  if (!viewOutput) return "unknown";
  try {
    const parsed = JSON.parse(viewOutput) as unknown;
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) return typeof parsed[0] === "string" ? parsed[0] : "unknown";
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).license === "string") {
      return (parsed as Record<string, string>).license;
    }
  } catch { /* plain text fallback below */ }
  const first = viewOutput.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim().slice(0, 80) : "unknown";
}

function pkgJsonPath(root: string, name: string): string {
  // Scoped names: @scope/pkg → node_modules/@scope/pkg/package.json
  return path.join(root, "node_modules", ...name.split("/"), "package.json");
}

function readPackageVersion(root: string, name: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath(root, name), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.replace(/-.*$/, ""));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

/** Small semver-range check (latest/*, exact, ^, ~, comparisons) — only used to decide "already in the shared folder". */
export function satisfiesRange(version: string, range: string): boolean {
  if (!range || range === "latest" || range === "*") return true;
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(range.trim());
  if (!m) return true;
  const have = parseVersion(version);
  const want = parseVersion(m[2]!);
  if (!have || !want) return true; // unparseable range: never block on our own arithmetic
  const cmp = compareVersions(have, want);
  switch (m[1] ?? "") {
    case "": case "=": return cmp === 0;
    case "^": return cmp >= 0 && have[0] === want[0];
    case "~": return cmp >= 0 && have[0] === want[0] && have[1] === want[1];
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    default: return true;
  }
}

/** Write the dependency into app/package.json without touching anything else. */
function upsertDependency(appDir: string, name: string, spec: string): void {
  const file = path.join(appDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { dependencies?: Record<string, string> };
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies[name] = spec;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

export type AddDependencyOutcome =
  | { ok: true; name: string; version: string; license: string; depsMode: AppProject["depsMode"]; licenceNote?: string; installed: boolean }
  | { ok: false; error: string };

/**
 * The §4.3.9 handler. When the shared deps folder already holds a satisfying
 * version only `package.json` changes; otherwise the project leaves the shared
 * folder: the junction is removed with `fs.unlinkSync` (never a recursive
 * delete) and npm installs into `app/` keeping the scaffolded lockfile.
 */
export async function addDependency(
  ctx: AppBuildContext,
  input: { name: string; range: string },
  deps: AppBuilderToolDeps = {},
): Promise<AddDependencyOutcome> {
  const { project, runId } = ctx;
  const name = input.name.trim();
  const range = (input.range || "latest").trim() || "latest";
  if (!NPM_NAME_RE.test(name)) return { ok: false, error: `invalid package name: ${name}` };
  if (!RANGE_RE.test(range)) return { ok: false, error: `invalid version range: ${range} (use a semver range or "latest")` };
  const d = { ...defaultDeps, ...deps };
  const license = parseLicense(await d.npmViewLicense(name, range));
  const appDir = path.join(project.workspaceDir, project.appDir);
  const sharedDir = depsDirFor(project);

  // Step 2: already present in the shared folder at a satisfying version.
  const sharedVersion = readPackageVersion(sharedDir, name);
  if (project.depsMode === "shared" && sharedVersion && satisfiesRange(sharedVersion, range)) {
    upsertDependency(appDir, name, `^${sharedVersion}`);
    const out = await finishAdd(ctx, name, sharedVersion, license, "shared", false);
    return out;
  }

  // Step 4: leave the shared folder. Remove the junction with unlink only.
  if (project.depsMode === "shared") {
    const nodeModules = path.join(appDir, "node_modules");
    if (fs.existsSync(nodeModules)) {
      try {
        fs.unlinkSync(nodeModules); // removes the link; the shared folder is untouched
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "ENOTEMPTY" && code !== "EISDIR") throw err;
        // A real (non-junction) node_modules: install in place, never delete it.
      }
    }
  }
  const code = await d.npmInstall(appDir, `${name}@${range}`, appProcessEnv(project));
  if (code !== 0) return { ok: false, error: `deps_install_failed: npm install exited ${code}` };
  const updated = updateAppProjectRow(project.id, { depsMode: "own" }) ?? { ...project, depsMode: "own" as const };
  const version = readPackageVersion(appDir, name) ?? "unknown";
  return await finishAdd({ ...ctx, project: updated }, name, version, license, "own", true);
}

async function finishAdd(
  ctx: AppBuildContext,
  name: string,
  version: string,
  license: string,
  depsMode: AppProject["depsMode"],
  installed: boolean,
): Promise<AddDependencyOutcome> {
  const licenseInNoteList = OK_LICENCES.has(license);
  recordAddedPackage(ctx.runId, { name, version, license, licenseInNoteList });
  const licenceNote = licenseInNoteList ? undefined : `Package licence to review: ${name} (${license})`;
  return { ok: true, name, version, license, depsMode, licenceNote, installed };
}

// ----------------------------------------------------------------------------
// Tool definitions. Schemas are the spec's verbatim; handlers are thin.
// ----------------------------------------------------------------------------

function ok(content: unknown): ToolResult {
  return { ok: true, content: typeof content === "string" ? content : JSON.stringify(content) };
}

function fail(content: string): ToolResult {
  return { ok: false, content };
}

/** The seven App Builder agent tools (MISSING §4.0 registration row). */
export function createAppBuilderTools(deps: AppBuilderToolDeps = {}): Tool[] {
  return [
    {
      name: "app_task_create",
      description: "Assign approved plan tasks to one role as a single bounded assignment. Only after the plan is approved.",
      parameters: {
        type: "object",
        required: ["role", "planTaskIds", "brief"],
        properties: {
          role: { type: "string", enum: ["engineer", "product", "architect", "data", "research", "seo"] },
          planTaskIds: { type: "array", items: { type: "string", pattern: "^T[0-9]{1,2}$" }, minItems: 1 },
          brief: { type: "string", minLength: 80, maxLength: 6000 },
        },
      },
      async run(args, ctx) {
        const build = activeAppBuildFor(ctx.taskId);
        if (!build) return noRun();
        const brief = typeof args.brief === "string" ? args.brief : "";
        if (brief.trim().length < 80) return fail("The brief must be at least 80 characters: goal, approved scope, out of scope, acceptance statements, context files, and the report ask.");
        const r = createAssignmentForPlan(build.project, {
          role: args.role as AppRoleId,
          planTaskIds: Array.isArray(args.planTaskIds) ? (args.planTaskIds as string[]) : [],
          brief,
        });
        if (!r.ok) return fail(r.error);
        return ok({ ok: true, assignmentId: r.assignment.id, role: r.assignment.role, planTaskIds: r.assignment.planTaskIds, status: r.assignment.status });
      },
    },
    {
      name: "app_task_finish",
      description: "Mark an assignment finished after reading the role's report. Sets the plan tasks to done or failed.",
      parameters: {
        type: "object",
        required: ["assignmentId", "outcome", "summary"],
        properties: {
          assignmentId: { type: "string", pattern: "^as_[a-z2-7]{12}$" },
          outcome: { type: "string", enum: ["done", "failed"] },
          summary: { type: "string", minLength: 20, maxLength: 1200 },
        },
      },
      async run(args, ctx) {
        const build = activeAppBuildFor(ctx.taskId);
        if (!build) return noRun();
        const r = finishAssignmentForPlan(build.project, {
          assignmentId: String(args.assignmentId ?? ""),
          outcome: args.outcome === "failed" ? "failed" : "done",
          summary: String(args.summary ?? ""),
        });
        if (!r.ok) return fail(r.error);
        return ok({ ok: true, assignmentId: r.assignment.id, status: r.assignment.status, planTaskIds: r.assignment.planTaskIds });
      },
    },
    {
      name: "app_context_write",
      description: "Update sections of .loam/context/PROJECT.md, PROGRESS.md or ARCHITECTURE.md. Each update replaces one section body and keeps the headings.",
      parameters: {
        type: "object",
        required: ["updates"],
        properties: {
          updates: {
            type: "array", minItems: 1, maxItems: 16,
            items: {
              type: "object", required: ["file", "heading", "body"],
              properties: {
                file: { type: "string", enum: ["PROJECT", "PROGRESS", "ARCHITECTURE"] },
                heading: { type: "string" },
                body: { type: "string", maxLength: 8000 },
              },
            },
          },
        },
      },
      async run(args, ctx) {
        const build = activeAppBuildFor(ctx.taskId);
        if (!build) return noRun();
        const updates = Array.isArray(args.updates) ? (args.updates as Array<{ file: string; heading: string; body: string }>) : [];
        const r = applyContextUpdates(build.project.workspaceDir, updates.map((u) => ({ file: u.file as "PROJECT" | "PROGRESS" | "ARCHITECTURE", heading: u.heading, body: u.body })));
        if (!r.ok) return fail(r.error);
        return ok(r);
      },
    },
    {
      name: "app_verify",
      description:
        "Run the app's checks in one call: placeholder check, DESIGN.md check, npm run check, lint, typecheck, build, and a visual review. " +
        "Call it once when the app is done. If it fails, fix only what failed and call it again. At most 3 calls per run.",
      parameters: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["fast", "standard", "strict"], description: "Leave empty to use the project's default." },
        },
        additionalProperties: false,
      },
      async run(args, ctx) {
        const build = activeAppBuildFor(ctx.taskId);
        if (!build) return noRun();
        if (!build.verify) return fail("app_verify needs this run's verify engine (dev server, visual reviewer); it is not available in this run.");
        const run = getRun(build.runId);
        const tier = resolveVerifyTier(build.project, run?.flavor ?? "goal", args.tier === "fast" || args.tier === "standard" || args.tier === "strict" ? args.tier : undefined);
        const report = await build.verify.run({ project: build.project, runId: build.runId, tier, signal: ctx.signal });
        insertVerifyReport(report);
        writeVerificationSummary(build.project.workspaceDir, verificationSummaryLine(report, build.project));
        emitProjectEvent(build.project.id, "appVerifyReport", {
          requestId: report.id,
          projectId: build.project.id,
          runId: build.runId,
          attempt: report.attempt,
          tier: report.tier,
          pass: report.pass,
          error: report.error,
        });
        return { ok: report.pass, content: formatVerifyReportForModel(report) };
      },
    },
    {
      name: "app_version_note",
      description:
        "Give the version you just finished a short title and summary. Call once, after app_verify passed. " +
        "Title: 2 to 6 words. Summary: 1 to 3 plain sentences on what changed for the user.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 60 },
          summary: { type: "string", maxLength: 600 },
        },
        required: ["title", "summary"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const build = activeAppBuildFor(ctx.taskId);
        if (!build) return noRun();
        const title = String(args.title ?? "").trim();
        const summary = String(args.summary ?? "").trim();
        if (!title || title.length > 60) return fail("title must be 1 to 60 characters");
        if (!summary || summary.length > 600) return fail("summary must be 1 to 600 characters");
        setVersionNote(build.runId, { title, summary });
        return ok({ ok: true, title, summary });
      },
    },
    {
      name: "app_db_query",
      description:
        "Run one read-only SQL SELECT on this app's local database (app/data/app.sqlite). Returns at most 50 rows as JSON. " +
        "Use it to check data the app saved. It cannot change data.",
      parameters: {
        type: "object",
        properties: { sql: { type: "string", maxLength: 2000 } },
        required: ["sql"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const build = activeAppBuildFor(ctx.taskId);
        if (!build) return noRun();
        const { project } = build;
        const sql = String(args.sql ?? "");
        if (sql.length > 2000) return fail("sql must be at most 2,000 characters");
        const dbFile = path.join(project.workspaceDir, project.appDir, "data", "app.sqlite");
        const r = appDbQueryFile(dbFile, sql);
        if (!r.ok) return fail(r.error === "no_database" ? "no_database: the app has no local database yet" : r.error === "select_only" ? "select_only: app_db_query runs one read-only SELECT or WITH statement" : `db_error: ${r.message ?? ""}`);
        const json = JSON.stringify(r.rows);
        return ok({ ok: true, rows: json.length > MAX_JSON_CHARS ? `${json.slice(0, MAX_JSON_CHARS)}…` : json, rowNote: r.truncated ? `result capped at ${MAX_ROWS} rows` : undefined });
      },
    },
    {
      name: "app_add_dependency",
      description:
        "Add one npm package to this app. Checks the licence (returns it as a note; never blocks), reuses the shared toolkit folder " +
        "when it already holds a satisfying version, and otherwise gives the project its own node_modules. No limit on how many packages you add.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "npm package name, e.g. \"marked\" or \"@scope/pkg\"" },
          range: { type: "string", description: "semver range or \"latest\" (default latest)" },
        },
        additionalProperties: false,
      },
      async run(args, ctx) {
        const build = activeAppBuildFor(ctx.taskId);
        if (!build) return noRun();
        const r = await addDependency(build, { name: String(args.name ?? ""), range: args.range === undefined ? "latest" : String(args.range) }, deps);
        if (!r.ok) return fail(r.error);
        return ok({ ok: true, name: r.name, version: r.version, license: r.license, depsMode: r.depsMode, ...(r.licenceNote ? { note: r.licenceNote } : {}) });
      },
    },
  ];
}

export const APP_BUILDER_TOOL_NAMES = [
  "app_task_create", "app_task_finish", "app_context_write", "app_verify",
  "app_version_note", "app_db_query", "app_add_dependency",
] as const;
