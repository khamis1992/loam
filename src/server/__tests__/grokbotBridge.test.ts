/**
 * Phase 3: one-way Grok Bot bridge. A mirrored message is stored (sqlite +
 * memory) and shown as a labelled note in the agent thread — it must never
 * start a run. Execute tasks require the bridge token; with a valid token they
 * enqueue a normal run for the agent.
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";

type Bridge = typeof import("../bridge/grokbot.js");
type Routes = typeof import("../routes/grokbotBridge.js");
type Db = typeof import("../db.js");
type Agents = typeof import("../agents.js");

let tmpDir = "";
let closeDb: () => void;
let bridge: Bridge;
let routes: Routes;
let db: Db;
let agents: Agents;
let server: http.Server;
let base: string;

const TOKEN = "bridge-secret-token-1234";

function listen(srv: http.Server): Promise<string> {
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as import("node:net").AddressInfo;
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

describe("grokbot bridge (phase 3)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-grokbot-bridge-"));
    process.env.MANUS_LOCAL_DATA_DIR = path.join(tmpDir, "data");
    delete process.env.LOAM_BRIDGE_TOKEN;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    bridge = await import("../bridge/grokbot.js");
    routes = await import("../routes/grokbotBridge.js");
    db = await import("../db.js");
    agents = await import("../agents.js");
    db.loadDb();

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      void routes.handleGrokbotBridgeRoutes(req, res, url.pathname, url).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    base = await listen(server);

    fs.writeFileSync(path.join(tmpDir, "data", "bridge-token"), TOKEN, "utf8");
    agents.createAgent({ name: "Grokked", source: "grokbot" });
  });

  after(async () => {
    delete process.env.LOAM_BRIDGE_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { closeDb(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mirror ingest stores a note and never starts a run", async () => {
    let runs = 0;
    (globalThis as { __loamRunTask?: unknown }).__loamRunTask = async () => {
      runs += 1;
      return { taskId: "", text: "" };
    };

    const res = await call("POST", "/api/bridge/grokbot/mirror", {
      agentRef: "Grokked",
      from: "Grok Bot",
      text: "Hello from Grok",
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body) as { agentId: string; message: { id: string; from: string } };
    assert.equal(parsed.message.from, "Grok Bot");

    // Store + list agree (memory cache + sqlite).
    try {
      bridge.resetGrokbotBridgeForTests();
    } catch { /* no-op */ }
    const listed = bridge.listMirrors((agents.listAgents(true)[0] as { id: string }).id);
    assert.ok(listed.some((m) => m.text === "Hello from Grok"));
    assert.equal(runs, 0);

    // execute:true on the mirror endpoint is rejected outright.
    const bad = await call("POST", "/api/bridge/grokbot/mirror", {
      agentRef: "Grokked",
      text: "should not run",
      execute: true,
    });
    assert.equal(bad.status, 400);
    assert.equal(runs, 0);
  });

  it("renders the mirrored note as a labelled thread note without a run", async () => {
    const agentId = (agents.listAgents(true)[0] as { id: string }).id;
    const task = db.createTask("thread seed", "Thread");
    db.setTaskAgent(task.id, agentId);
    // Map the agent to its thread like the web UI does on first message.
    await import("../agentThreads.js").then((t) => t.setThread(agentId, task.id));

    const res = await call("POST", "/api/bridge/grokbot/mirror", {
      agentRef: agentId,
      text: "Second mirror",
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body) as { message: { threadAppended: boolean } } ? true : true, true);
    const parsed = JSON.parse(res.body) as { message: { threadAppended: boolean } };
    assert.equal(parsed.message.threadAppended, true);
    const note = db.getTask(task.id)?.messages.find((m) => m.content.startsWith("from Grok Bot:"));
    assert.ok(note);
    assert.ok(note!.content.endsWith("Second mirror"));
    assert.equal(note!.role, "user");
  });

  it("rejects execute without a valid token", async () => {
    let runs = 0;
    (globalThis as { __loamRunTask?: unknown }).__loamRunTask = async () => {
      runs += 1;
      return { taskId: "", text: "" };
    };
    const wrong = await call("POST", "/api/bridge/grokbot/task", { agentRef: "Grokked", text: "do it", execute: true, token: "nope" });
    assert.equal(wrong.status, 403);
    const noToken = await call("POST", "/api/bridge/grokbot/task", { agentRef: "Grokked", text: "do it", execute: true });
    assert.equal(noToken.status, 403);
    const missingFlag = await call("POST", "/api/bridge/grokbot/task", { agentRef: "Grokked", text: "do it", token: TOKEN });
    assert.equal(missingFlag.status, 400);
    const executeFalse = await call("POST", "/api/bridge/grokbot/task", { agentRef: "Grokked", text: "do it", execute: false, token: TOKEN });
    assert.equal(executeFalse.status, 400);
    assert.equal(runs, 0);
  });

  it("enqueues a real run with a valid token", async () => {
    const captured: Array<{ taskId?: string; prompt: string; agentId?: string }> = [];
    (globalThis as { __loamRunTask?: unknown }).__loamRunTask = async (opts: { taskId?: string; prompt: string; agentId?: string }) => {
      captured.push(opts);
      return { taskId: opts.taskId ?? "", text: "ok" };
    };
    const res = await call("POST", "/api/bridge/grokbot/task", { agentRef: "Grokked", text: "Run the recap", execute: true, token: TOKEN });
    assert.equal(res.status, 202);
    const parsed = JSON.parse(res.body) as { taskId: string; agentId: string };
    assert.equal(parsed.agentId, (agents.listAgents(true)[0] as { id: string }).id);
    assert.equal(db.getTask(parsed.taskId)?.prompt, "Run the recap");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.agentId, parsed.agentId);
    assert.equal(captured[0]!.prompt, "Run the recap");
  });

  it("unknown agentRef is a 404 on both endpoints", async () => {
    const mirror = await call("POST", "/api/bridge/grokbot/mirror", { agentRef: "nonexistent", text: "x" });
    assert.equal(mirror.status, 404);
    const task = await call("POST", "/api/bridge/grokbot/task", { agentRef: "nonexistent", text: "x", execute: true, token: TOKEN });
    assert.equal(task.status, 404);
  });
});
