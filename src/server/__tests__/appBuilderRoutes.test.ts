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
  await call("POST", `/api/app-projects/${id}/queue/resume`);
  const est = await call("GET", `/api/app-projects/${id}/races/estimate?branches=3`);
  assert.equal((est.body as { estimate: { maxTotalCredits: number } }).estimate.maxTotalCredits, 45);
  const usage = await call("GET", `/api/app-projects/${id}/usage`);
  assert.equal((usage.body as { rows: unknown[] }).rows.length, 0);
  const putAi = await call("PUT", `/api/app-projects/${id}/ai`, { dailyTokenCap: 5 });
  assert.equal(putAi.status, 400, "cap below the minimum");
  const putModel = await call("PUT", `/api/app-projects/${id}/ai`, { model: "gpt-x" });
  assert.equal(putModel.status, 200);
});

test("router: files tree/view/put with traversal refusal + stale detection", async () => {
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
  const put = await call("PUT", `/api/app-projects/${id}/files`, { path: "src/new.ts", content: "export {};", baseSha1: "deadbeef" });
  assert.equal(put.status, 200);
  const stale = await call("PUT", `/api/app-projects/${id}/files`, { path: "index.html", content: "new", baseSha1: "deadbeef" });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: string }).error, "stale_file");
  const search = await call("GET", `/api/app-projects/${id}/search?q=محتوى`);
  assert.deepEqual((search.body as { hits: Array<{ path: string }> }).hits.map((h) => h.path), ["index.html"]);
});

test("router: runtime errors + engine-pending areas", async () => {
  const created = await call("POST", "/api/app-projects", { title: "err" });
  const id = (created.body as { project: { id: string } }).project.id;
  const errors = await call("GET", `/api/app-projects/${id}/runtime-errors`);
  assert.equal((errors.body as { errors: unknown[] }).errors.length, 0);
  const run = await call("POST", `/api/app-projects/${id}/runs`, { prompt: "x", flavor: "quick" });
  assert.equal(run.status, 501);
  assert.equal((run.body as { error: string }).error, "engine_pending");
  const version = await call("GET", `/api/app-projects/${id}/versions`);
  assert.equal(version.status, 501);
  const pre = await call("GET", "/api/app-projects/preflight");
  assert.equal((pre.body as { preflight: { ok: boolean; items: unknown[] } }).preflight.items.length > 0, true);
});
