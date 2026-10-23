/**
 * D16 session-control tests:
 *  - side-chat ("/btw") runs are restricted to read-only tools (no mutating tool);
 *  - POST /api/tasks/:id/pause stops a running task;
 *  - POST /api/tasks/:id/resume appends the "user changed X" note and continues.
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";

type Db = typeof import("../db.js");
type Routes = typeof import("../routes/sessionControl.js");
type SideChat = typeof import("../../agent/sideChat.js");
type Registry = typeof import("../../tools/registry.js");

let tmpDir = "";
let closeDb: () => void;
let db: Db;
let routes: Routes;
let sideChat: SideChat;
let registryMod: Registry;
let server: http.Server;
let base: string;
let captured: Array<{ taskId?: string; prompt: string; sideChat?: boolean; resume?: boolean }> = [];

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(base + url, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.text() };
}

function makeRegistry() {
  const reg = new registryMod.ToolRegistry();
  const names = [...sideChat.SIDE_CHAT_READ_ONLY_TOOLS, ...sideChat.MUTATING_TOOLS];
  for (const name of names) {
    reg.register({ name, description: name, parameters: {}, run: async () => ({ ok: true, content: "" }) });
  }
  return reg;
}

describe("session control routes (D16)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-session-control-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    routes = await import("../routes/sessionControl.js");
    sideChat = await import("../../agent/sideChat.js");
    registryMod = await import("../../tools/registry.js");
    db.loadDb();

    (globalThis as { __loamRegistry?: unknown }).__loamRegistry = makeRegistry();
    (globalThis as { __loamRunTask?: unknown }).__loamRunTask = async (opts: { taskId?: string; prompt: string; sideChat?: boolean; resume?: boolean }) => {
      captured.push(opts);
      return { taskId: opts.taskId ?? "", text: "ok" };
    };

    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      void routes.handleSessionControlRoutes(req, res, p).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    base = await listen(server);
  });

  after(async () => {
    delete (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
    delete (globalThis as { __loamRegistry?: unknown }).__loamRegistry;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { closeDb(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("narrows a side-chat run to read-only tools and never exposes mutating tools", () => {
    const reg = makeRegistry();
    const names = sideChat.buildSideChatTools(reg).names();
    assert.ok(names.length > 0, "side chat must keep at least one inspection tool");
    for (const name of names) {
      assert.ok(!sideChat.MUTATING_TOOLS.includes(name), `mutating tool leaked into side chat: ${name}`);
    }
    const resolved = routes.sideChatToolNames();
    assert.ok(resolved.length > 0);
    assert.deepEqual(
      resolved.filter((n) => sideChat.MUTATING_TOOLS.includes(n)),
      [],
      "sideChatToolNames must never contain a mutating tool",
    );
  });

  it("starts a read-only side-chat run while the main run continues", async () => {
    const task = db.createTask("main work", "Main");
    captured = [];
    const res = await call("POST", `/api/tasks/${task.id}/btw`, { question: "what changed in src/index.ts?" });
    assert.equal(res.status, 202);
    const body = JSON.parse(res.body) as { taskId: string; sideChat: boolean; readOnlyTools: string[] };
    assert.equal(body.sideChat, true);
    assert.ok(body.taskId.length > 0);
    for (const name of body.readOnlyTools) {
      assert.ok(!sideChat.MUTATING_TOOLS.includes(name), `side-chat run exposed mutating tool: ${name}`);
    }
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.taskId, body.taskId);
    assert.equal(captured[0]!.sideChat, true);
  });

  it("rejects an empty side-chat question", async () => {
    const task = db.createTask("main work 2", "Main");
    assert.equal((await call("POST", `/api/tasks/${task.id}/btw`, { question: "  " })).status, 400);
    assert.equal((await call("POST", "/api/tasks/task_missing/btw", { question: "hi" })).status, 404);
  });

  it("pauses a running task", async () => {
    const task = db.createTask("pausable", "Pause");
    db.setTaskStatus(task.id, "running");
    const res = await call("POST", `/api/tasks/${task.id}/pause`);
    assert.equal(res.status, 200);
    assert.equal(routes.isSessionPaused(task.id), true);
    assert.ok((routes.getPauseState(task.id)?.at ?? 0) > 0);
  });

  it("rejects pausing an idle or unknown task", async () => {
    const idle = db.createTask("idle", "Idle");
    db.setTaskStatus(idle.id, "done");
    assert.equal((await call("POST", `/api/tasks/${idle.id}/pause`)).status, 409);
    assert.equal((await call("POST", "/api/tasks/task_missing/pause")).status, 404);
  });

  it("resumes a paused task with the user's take-over note", async () => {
    const task = db.createTask("takeover", "Takeover");
    db.setTaskStatus(task.id, "running");
    assert.equal((await call("POST", `/api/tasks/${task.id}/pause`)).status, 200);

    captured = [];
    const res = await call("POST", `/api/tasks/${task.id}/resume`, { note: "src/index.ts" });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { paused: boolean; note: string };
    assert.equal(body.paused, false);
    assert.equal(body.note, "user changed: src/index.ts");
    assert.equal(routes.isSessionPaused(task.id), false);

    const after = db.getTask(task.id);
    assert.ok(after, "task must still exist after resume");
    assert.ok(after.messages.some((m) => m.role === "user" && m.content === "user changed: src/index.ts"), "take-over note must be recorded");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.resume, true);
  });

  it("rejects resuming a task that is not paused", async () => {
    const task = db.createTask("not paused", "Free");
    db.setTaskStatus(task.id, "done");
    assert.equal((await call("POST", `/api/tasks/${task.id}/resume`, { note: "x" })).status, 409);
  });
});
