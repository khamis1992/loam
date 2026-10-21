/**
 * Option #12 unit tests: POST /api/tasks/:id/retry-last re-runs the newest
 * user turn of a finished task through the shared run engine. The engine is
 * stubbed via the same globalThis bridge the real runtime uses
 * (src/index.ts sets __loamRunTask).
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";

type Db = typeof import("../db.js");
type Routes = typeof import("../routes/retryLast.js");

let tmpDir = "";
let closeDb: () => void;
let db: Db;
let routes: Routes;
let server: http.Server;
let base: string;
let captured: Array<{ taskId?: string; prompt: string; model?: string; agentId?: string; mode?: string }> = [];

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function call(method: string, url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(base + url, { method });
  const body = await res.text();
  return { status: res.status, body };
}

describe("retry-last route (option #12)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-retry-last-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    routes = await import("../routes/retryLast.js");
    db.loadDb();

    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      void routes.handleRetryLastRoutes(req, res, p).then((handled) => {
        if (!handled) { res.writeHead(404).end(); }
      });
    });
    base = await listen(server);
  });

  after(async () => {
    delete (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { closeDb(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("re-runs the last user turn on the same task", async () => {
    const created = db.createTask("first prompt", "Retry");
    db.appendMessage(created.id, "user", "first prompt");
    db.appendMessage(created.id, "assistant", "first answer");
    db.setTaskStatus(created.id, "done", { model: "test-model" });
    db.setTaskMode(created.id, "ask");

    captured = [];
    (globalThis as { __loamRunTask?: unknown }).__loamRunTask = async (opts: { taskId?: string; prompt: string }) => {
      captured.push(opts);
      return { taskId: opts.taskId ?? "", text: "ok" };
    };

    const res = await call("POST", `/api/tasks/${created.id}/retry-last`);
    assert.equal(res.status, 202);
    const body = JSON.parse(res.body) as { taskId: string; retriedPrompt: string };
    assert.equal(body.taskId, created.id);
    assert.equal(body.retriedPrompt, "first prompt");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.taskId, created.id);
    assert.equal(captured[0]!.prompt, "first prompt");
    assert.equal(captured[0]!.model, "test-model");
    assert.equal(captured[0]!.mode, "ask");
  });

  it("rejects running tasks, empty tasks and unknown tasks", async () => {
    const created = db.createTask("busy", "Busy");
    db.appendMessage(created.id, "user", "busy");
    db.setTaskStatus(created.id, "running");

    (globalThis as { __loamRunTask?: unknown }).__loamRunTask = async () => ({ taskId: "", text: "" });
    assert.equal((await call("POST", `/api/tasks/${created.id}/retry-last`)).status, 409);

    const empty = db.createTask("no turns", "Empty");
    db.setTaskStatus(empty.id, "done");
    assert.equal((await call("POST", `/api/tasks/${empty.id}/retry-last`)).status, 409);

    assert.equal((await call("POST", "/api/tasks/task_missing/retry-last")).status, 404);
  });

  it("answers 503 when the run engine bridge is absent", async () => {
    const created = db.createTask("engine", "Engine");
    db.appendMessage(created.id, "user", "engine");
    db.setTaskStatus(created.id, "done");
    delete (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
    assert.equal((await call("POST", `/api/tasks/${created.id}/retry-last`)).status, 503);
  });
});
