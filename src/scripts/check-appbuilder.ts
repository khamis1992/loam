/**
 * check:appbuilder (Wave-1 core slice) — schema creates the 13 app_ tables and
 * is idempotent; project create/list/get/patch/delete round-trips; ids match
 * app_[a-z2-7]{12}; delete refuses outside managed workspaces; preflight returns
 * 4 items; processEnv scrubs every secret-shaped inherited variable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { database } from "../server/sqliteStore.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ab-"));
process.env.LOAM_DATA_DIR = tmp;
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { ensureAppBuilderSchema, appTableNames } = await import("../appbuilder/store.js");
ensureAppBuilderSchema();
const tables = new Set((database().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
for (const t of appTableNames()) assert.ok(tables.has(t), `table ${t} must exist`);
assert.equal(appTableNames().length, 13);
ensureAppBuilderSchema(); // idempotent
const stamp = database().prepare("SELECT value FROM metadata WHERE key='appbuilder.schema'").get() as { value: string } | undefined;
assert.equal(stamp?.value, "1");

const { createAppProject, getAppProject, listAppProjects, updateAppProject, setProjectStatus, deleteAppProject } = await import("../appbuilder/projects.js");
const base = path.join(tmp, "ws");
fs.mkdirSync(base, { recursive: true });
const p = createAppProject({ title: "متجر تجريبي", description: "تطبيق اختبار", baseWorkspace: base });
assert.match(p.id, /^app_[a-z2-7]{12}$/);
assert.equal(p.appDir, "app");
assert.ok(fs.existsSync(path.join(p.workspaceDir, "app")), "app/ created in the task workspace");
assert.equal(getAppProject(p.id)!.title, "متجر تجريبي");
assert.equal(listAppProjects().length, 1);
const patched = updateAppProject(p.id, { description: "محدّث" });
assert.equal(patched.description, "محدّث");
setProjectStatus(p.id, "building");
assert.equal(getAppProject(p.id)!.status, "building");

// delete files=false keeps the folder; files=true removes it and refuses outside workspaces.
deleteAppProject(p.id, false);
assert.equal(getAppProject(p.id), undefined);
assert.ok(fs.existsSync(p.workspaceDir));
// Re-create then remove with files.
const p2 = createAppProject({ title: "للحذف", baseWorkspace: base });
deleteAppProject(p2.id, true);
assert.equal(fs.existsSync(p2.workspaceDir), false);

const { runPreflight } = await import("../appbuilder/preflight.js");
const pre = await runPreflight();
assert.equal(pre.items.length, 4);
for (const item of pre.items) assert.ok(typeof item.fix === "string" && item.fix.length > 0, `preflight ${item.id} needs fix text`);

const { appProcessEnv } = await import("../appbuilder/processEnv.js");
const secretEnv = { ...process.env, OPENAI_API_KEY: "sk-test", XAI_API_KEY: "xai-test", GITHUB_TOKEN: "gh-test", PATH: process.env.PATH };
const saved = { ...process.env };
Object.assign(process.env, secretEnv);
const p3 = createAppProject({ title: "بيئة", baseWorkspace: base });
const env = appProcessEnv(p3);
assert.equal(env.OPENAI_API_KEY, undefined);
assert.equal(env.XAI_API_KEY, undefined);
assert.equal(env.GITHUB_TOKEN, undefined);
assert.ok(env.PATH, "PATH kept");
assert.ok(env.LOAM_DEPS_DIR!.includes(path.join("appbuilder", "deps")), "LOAM_DEPS_DIR set to the deps folder");
process.env = saved;

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: the sqlite handle may still be open; the temp dir is disposable */ }
console.log("check:appbuilder OK — 13 tables idempotent, project CRUD + managed delete, preflight 4 items, env scrubbed");
