import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let agents: typeof import("../agents.js");
let db: typeof import("../db.js");
let threads: typeof import("../agentThreads.js");

describe("agent chat meta (agents list)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agentmeta-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    threads = await import("../agentThreads.js");
    agents = await import("../agents.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns no chat fields for an agent without a thread", () => {
    const agent = agents.createAgent({ name: "no-thread" });
    assert.deepEqual(agents.agentChatMeta(agent.id), {});

    const listed = agents.listAgentsWithChatMeta().find((a) => a.id === agent.id);
    assert.ok(listed);
    // AgentRecord fields are preserved; the chat fields stay absent.
    assert.equal(listed!.name, "no-thread");
    assert.equal(listed!.lastMessage, undefined);
    assert.equal(listed!.waitingForYou, undefined);
    assert.equal(listed!.unreadCount, undefined);
    assert.equal(listed!.lastActivityAt, undefined);
  });

  it("exposes the last message, waiting state, unread count and activity", () => {
    const agent = agents.createAgent({ name: "with-thread" });
    const task = db.createTask("hello", "hello", null, agent.id);
    db.appendMessage(task.id, "user", "  hello   world  ");
    db.appendMessage(task.id, "assistant", "on   it");
    threads.setThread(agent.id, task.id);
    threads.touchMessage(agent.id);

    const meta = agents.agentChatMeta(agent.id);
    assert.equal(meta.lastMessage, "on it"); // whitespace collapsed
    assert.equal(meta.waitingForYou, true); // assistant replied last
    assert.equal(meta.unreadCount, 2); // never seen
    assert.ok(typeof meta.lastActivityAt === "number");
  });

  it("drops the unread count once the thread is seen and tracks the user's turn", () => {
    const agent = agents.createAgent({ name: "seen" });
    const task = db.createTask("hi", "hi", null, agent.id);
    db.appendMessage(task.id, "assistant", "first");
    threads.setThread(agent.id, task.id);
    threads.touchMessage(agent.id);
    threads.markSeen(agent.id);

    const seen = agents.agentChatMeta(agent.id);
    assert.equal(seen.lastMessage, "first");
    assert.equal(seen.waitingForYou, true);
    assert.equal(seen.unreadCount, undefined);
  });

  it("is not waiting for the user when the user sent the last message", () => {
    const agent = agents.createAgent({ name: "user-last" });
    const task = db.createTask("q", "q", null, agent.id);
    db.appendMessage(task.id, "assistant", "question?");
    db.appendMessage(task.id, "user", "answer");
    threads.setThread(agent.id, task.id);
    threads.touchMessage(agent.id);

    const meta = agents.agentChatMeta(agent.id);
    assert.equal(meta.lastMessage, "answer");
    assert.equal(meta.waitingForYou, false);
    assert.equal(meta.unreadCount, 2);
  });
});
