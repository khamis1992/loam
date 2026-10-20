import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { AgentThreadInfo } from "../agentThreads.js";

interface AgentThreadsApi {
  getThread: (agentId: string) => AgentThreadInfo | undefined;
  setThread: (agentId: string, threadUid: string) => AgentThreadInfo;
  markSeen: (agentId: string, at?: string) => AgentThreadInfo;
  touchMessage: (agentId: string, at?: string) => void;
  listThreads: () => AgentThreadInfo[];
}

let tmpDir = "";
let closeDb: () => void;
let api: AgentThreadsApi;

describe("agentThreads", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agent-threads-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const mod = await import("../agentThreads.js");
    api = {
      getThread: mod.getThread,
      setThread: mod.setThread,
      markSeen: mod.markSeen,
      touchMessage: mod.touchMessage,
      listThreads: mod.listThreads,
    };
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("maps agents to threads and lists them", () => {
    assert.equal(api.getThread("missing-agent"), undefined);
    assert.equal(api.listThreads().length, 0);

    const set = api.setThread("agent_a", "thread-1");
    assert.equal(set.agentId, "agent_a");
    assert.equal(set.threadUid, "thread-1");
    assert.equal(set.unread, false);

    const got = api.getThread("agent_a");
    assert.ok(got);
    assert.equal(got!.threadUid, "thread-1");

    api.setThread("agent_b", "thread-2");
    const all = api.listThreads();
    assert.equal(all.length, 2);
    assert.deepStrictEqual(all.map((t) => t.agentId).sort(), ["agent_a", "agent_b"]);
  });

  it("marks seen and computes unread from later messages", () => {
    api.setThread("agent_c", "thread-c");
    api.touchMessage("agent_c", "2026-01-01T00:00:00.000Z");
    assert.equal(api.getThread("agent_c")!.unread, true);

    const seen = api.markSeen("agent_c", "2026-01-01T00:01:00.000Z");
    assert.equal(seen.unread, false);
    assert.equal(seen.lastSeenAt, "2026-01-01T00:01:00.000Z");
    assert.equal(api.getThread("agent_c")!.unread, false);

    api.touchMessage("agent_c", "2026-01-01T00:02:00.000Z");
    assert.equal(api.getThread("agent_c")!.unread, true);

    api.markSeen("agent_c", "2026-01-01T00:03:00.000Z");
    assert.equal(api.getThread("agent_c")!.unread, false);
  });

  it("ignores older touchMessage timestamps and unknown agents", () => {
    api.setThread("agent_d", "thread-d");
    api.touchMessage("agent_d", "2026-01-01T00:00:00.000Z");
    api.touchMessage("agent_d", "2025-12-31T00:00:00.000Z");
    assert.equal(api.getThread("agent_d")!.lastMessageAt, "2026-01-01T00:00:00.000Z");

    api.touchMessage("agent_undefined", "2026-01-01T00:00:00.000Z");
    assert.equal(api.getThread("agent_undefined"), undefined);
  });

  it("resets seen and message state when the thread changes", () => {
    api.setThread("agent_e", "thread-e1");
    api.touchMessage("agent_e", "2026-01-01T00:00:00.000Z");
    api.markSeen("agent_e");
    assert.equal(api.getThread("agent_e")!.unread, false);

    const switched = api.setThread("agent_e", "thread-e2");
    assert.equal(switched.threadUid, "thread-e2");
    assert.equal(switched.lastSeenAt, undefined);
    assert.equal(switched.lastMessageAt, undefined);
    assert.equal(switched.unread, false);
  });

  it("rejects empty thread uids and seen for unknown mappings", () => {
    assert.throws(() => api.setThread("agent_x", "   "), /threadUid is required/);
    assert.throws(() => api.markSeen("agent_x"), /agent thread not found/);
  });
});
