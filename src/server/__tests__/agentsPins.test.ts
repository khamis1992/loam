/**
 * Endpoint test for the companion pin / reorder / hide HTTP surface:
 *   POST /api/agents/:id/pin   { pinned?: boolean }  (default true, idempotent)
 *   POST /api/agents/reorder   { ids: string[] }     (dense pinned order)
 *   POST /api/agents/:id/hide  { hidden?: boolean }  (default true, idempotent)
 *
 * The handlers live inline in startServer(), so this spins up the real loopback
 * server on an ephemeral port with the install token disabled (LOAM_AUTH_DISABLED)
 * and exercises the routes over HTTP against an isolated data dir.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { after, before, describe, it } from "node:test";

interface Agent {
  id: string;
  name: string;
  pinnedAt?: number;
  sortOrder?: number;
  hiddenAt?: string;
  createdAt: string;
}

interface Reply {
  status: number;
  body: {
    agent?: Agent;
    agents?: Agent[];
    pinned?: Agent[];
    hidden?: boolean;
    error?: string;
  };
}

let tmpDir = "";
let server: http.Server;
let closeDb: () => void;
let base = "";

async function call(method: string, p: string, body?: unknown): Promise<Reply> {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Reply["body"] = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Reply["body"];
    } catch {
      parsed = { error: text };
    }
  }
  return { status: res.status, body: parsed };
}

async function createAgent(name: string): Promise<Agent> {
  const res = await call("POST", "/api/agents", { name });
  assert.equal(res.status, 200, `create ${name}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.agent, "create must return the agent");
  return res.body.agent;
}

describe("agent pin / reorder / hide endpoints", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agentpins-api-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    // `loadConfig()` mkdirs `workspace/` and `workspace/.screenshots/` as a side
    // effect; LOAM_ROOT keeps them inside the temp dir instead of the repo.
    process.env.LOAM_ROOT = tmpDir;
    process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
    process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmpDir, "evals");
    process.env.LOAM_AUTH_DISABLED = "true";
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const config = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      config,
      JSON.stringify({ workspace, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, computerUse: { enabled: false }, mcpServers: {} }),
      "utf8",
    );
    process.env.LOAM_CONFIG = config;

    const { loadConfig } = await import("../../config.js");
    const { OllamaClient } = await import("../../ollama.js");
    const { startServer } = await import("../http.js");
    const cfg = loadConfig();
    cfg.server.host = "127.0.0.1";
    cfg.server.port = 0;
    server = await startServer({
      cfg,
      ollama: new OllamaClient("http://127.0.0.1:1"),
      runTask: async () => ({ taskId: "test", text: "" }),
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    closeDb = (await import("../sqliteStore.js")).closeDb;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    delete process.env.MANUS_LOCAL_SKILLS_DIR;
    delete process.env.MANUS_LOCAL_EVALS_DIR;
    delete process.env.LOAM_CONFIG;
    delete process.env.LOAM_AUTH_DISABLED;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates agents unpinned and lists them in creation order", async () => {
    const a = await createAgent("pins-api-alpha");
    const b = await createAgent("pins-api-bravo");
    assert.equal(a.pinnedAt, undefined);
    assert.equal(b.pinnedAt, undefined);
    const list = await call("GET", "/api/agents");
    assert.equal(list.status, 200);
    const names = (list.body.agents ?? []).map((x) => x.name);
    assert.ok(names.indexOf("pins-api-alpha") < names.indexOf("pins-api-bravo"));
  });

  it("pins by default, sorts pinned first, and unpins with pinned:false", async () => {
    const a = await createAgent("pin-default");
    const pin = await call("POST", `/api/agents/${a.id}/pin`);
    assert.equal(pin.status, 200);
    assert.equal(typeof pin.body.agent?.pinnedAt, "number");
    assert.equal(typeof pin.body.agent?.sortOrder, "number");

    const list = await call("GET", "/api/agents");
    const agents = list.body.agents ?? [];
    const pinnedIdx = agents.findIndex((x) => x.id === a.id);
    const firstUnpinned = agents.findIndex((x) => typeof x.pinnedAt !== "number");
    assert.ok(pinnedIdx >= 0 && pinnedIdx < firstUnpinned, "pinned agent must rank inside the pinned block");

    const unpin = await call("POST", `/api/agents/${a.id}/pin`, { pinned: false });
    assert.equal(unpin.status, 200);
    assert.equal(unpin.body.agent?.pinnedAt, undefined);
    assert.equal(unpin.body.agent?.sortOrder, undefined);
  });

  it("is idempotent: re-pinning keeps the original pinnedAt", async () => {
    const a = await createAgent("pin-idempotent");
    const first = await call("POST", `/api/agents/${a.id}/pin`, { pinned: true });
    const again = await call("POST", `/api/agents/${a.id}/pin`, { pinned: true });
    assert.equal(first.status, 200);
    assert.equal(again.status, 200);
    assert.equal(first.body.agent?.pinnedAt, again.body.agent?.pinnedAt);
  });

  it("returns 404 when pinning an unknown agent", async () => {
    const res = await call("POST", "/api/agents/agent_missing/pin", { pinned: true });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  it("reorders pinned agents from an id sequence and returns the pinned block", async () => {
    const a = await createAgent("pin-order-a");
    const b = await createAgent("pin-order-b");
    const c = await createAgent("pin-order-c");
    await call("POST", `/api/agents/${c.id}/pin`);
    await call("POST", `/api/agents/${b.id}/pin`);
    await call("POST", `/api/agents/${a.id}/pin`);

    const mine = (list: Agent[]): Agent[] => list.filter((x) => x.name.startsWith("pin-order-"));
    const before = await call("GET", "/api/agents");
    assert.deepEqual(mine(before.body.agents ?? []).map((x) => x.name), ["pin-order-c", "pin-order-b", "pin-order-a"]);

    const reordered = await call("POST", "/api/agents/reorder", { ids: [a.id, b.id, c.id] });
    assert.equal(reordered.status, 200);
    assert.ok(Array.isArray(reordered.body.pinned));
    assert.deepEqual(mine(reordered.body.pinned ?? []).map((x) => x.name), ["pin-order-a", "pin-order-b", "pin-order-c"]);
    assert.deepEqual(mine(reordered.body.pinned ?? []).map((x) => x.sortOrder), [0, 1, 2]);

    const again = await call("POST", "/api/agents/reorder", { ids: [a.id, b.id, c.id] });
    assert.deepEqual(mine(again.body.pinned ?? []).map((x) => x.sortOrder), [0, 1, 2]);
    assert.deepEqual(mine(again.body.pinned ?? []).map((x) => x.name), ["pin-order-a", "pin-order-b", "pin-order-c"]);
  });

  it("reorder ignores unknown or unpinned ids and keeps them out of the pinned block", async () => {
    const unpinned = await createAgent("pin-order-unpinned");
    const res = await call("POST", "/api/agents/reorder", { ids: [unpinned.id, "agent_bogus"] });
    assert.equal(res.status, 200);
    assert.ok(!(res.body.pinned ?? []).some((x) => x.id === unpinned.id));
    assert.equal(unpinned.pinnedAt, undefined);
  });

  it("rejects a non-array ids body with 400", async () => {
    const res = await call("POST", "/api/agents/reorder", { ids: "not-an-array" });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it("hides and unhides, preserving hiddenAt across a redundant hide", async () => {
    const a = await createAgent("hide-toggle");
    const hide = await call("POST", `/api/agents/${a.id}/hide`);
    assert.equal(hide.status, 200);
    assert.equal(hide.body.hidden, true);
    assert.equal(typeof hide.body.agent?.hiddenAt, "string");

    const hideAgain = await call("POST", `/api/agents/${a.id}/hide`, { hidden: true });
    assert.equal(hideAgain.body.agent?.hiddenAt, hide.body.agent?.hiddenAt, "redundant hide keeps hiddenAt");

    const show = await call("POST", `/api/agents/${a.id}/hide`, { hidden: false });
    assert.equal(show.status, 200);
    assert.equal(show.body.hidden, false);
    assert.equal(show.body.agent?.hiddenAt, undefined);
  });

  it("returns 404 when hiding an unknown agent", async () => {
    const res = await call("POST", "/api/agents/agent_missing/hide", { hidden: true });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});
