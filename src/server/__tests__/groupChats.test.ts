import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after, afterEach } from "node:test";

import type { ToolContext } from "../../tools/registry.js";

interface GroupChatsApi {
  createGroup: (name: string, members?: string[]) => { id: string; name: string; memberIds: string[] };
  getGroup: (id: string) => { id: string; name: string; memberIds: string[] } | undefined;
  listGroups: () => Array<{ id: string }>;
  addGroupMember: (groupId: string, agentId: string) => unknown;
  removeGroupMember: (groupId: string, agentId: string) => unknown;
  listGroupMessages: (groupId: string) => Array<{ author: string; text: string; handoffTo: string | null; handoffNote: string | null }>;
  postToGroup: (
    groupId: string,
    text: string,
    author: string,
    startRun?: (input: { groupId: string; agentId: string; prompt: string; title?: string }) => { taskId: string },
  ) => Promise<{ targetAgentId: string | null; taskId: string | null }>;
  recordHandoffForTask: (taskId: string, agentName: string, note?: string) => { ok: boolean; reason?: string; agent?: { id: string; name: string } };
  collectGroupReplies: (
    startRun?: (input: { groupId: string; agentId: string; prompt: string; title?: string }) => { taskId: string },
  ) => Promise<number>;
  listPendingGroupTasks: () => Array<{ taskId: string; groupId: string; agentId: string; handoffTo: string | null; handoffNote: string | null }>;
}

interface GroupToolsApi {
  createGroupTools: () => Array<{
    name: string;
    run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ ok: boolean; content: string }>;
  }>;
}

let tmpDir = "";
let closeDb: () => void;
let api: GroupChatsApi;
let tools: GroupToolsApi;
let db: {
  createTask: (prompt: string, title?: string, projectId?: string | null, agentId?: string | null) => { id: string };
  completeTaskRun: (taskId: string, text: string, model: string) => void;
  setTaskStatus: (taskId: string, status: string, extra?: { error?: string }) => void;
};

function mockStarter(created: Array<{ agentId: string; prompt: string; taskId: string }>) {
  return (input: { groupId: string; agentId: string; prompt: string; title?: string }) => {
    const task = db.createTask(input.prompt, input.title, null, input.agentId);
    created.push({ agentId: input.agentId, prompt: input.prompt, taskId: task.id });
    return { taskId: task.id };
  };
}

describe("groupChats", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-group-chats-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = (await import("../db.js")) as unknown as typeof db;
    api = (await import("../groupChats.js")) as unknown as GroupChatsApi;
    tools = (await import("../../tools/groupTools.js")) as unknown as GroupToolsApi;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Drain tasks started by a test so the global poller cannot leak them into
  // the next test's pending list.
  afterEach(async () => {
    for (const pending of api.listPendingGroupTasks()) {
      db.completeTaskRun(pending.taskId, "(drained)", "test-model");
    }
    await api.collectGroupReplies();
  });

  it("creates groups and keeps members ordered", () => {
    const group = api.createGroup("Triage", ["agent_a", "agent_b"]);
    assert.equal(group.name, "Triage");
    assert.deepStrictEqual(group.memberIds, ["agent_a", "agent_b"]);
    assert.equal(api.listGroups().length, 1);

    api.addGroupMember(group.id, "agent_c");
    assert.deepStrictEqual(api.getGroup(group.id)!.memberIds, ["agent_a", "agent_b", "agent_c"]);
    api.removeGroupMember(group.id, "agent_b");
    assert.deepStrictEqual(api.getGroup(group.id)!.memberIds, ["agent_a", "agent_c"]);
  });

  it("routes user messages to an @mention, otherwise the first member", async () => {
    const group = api.createGroup("Routing", ["agent_a", "agent_b"]);
    const created: Array<{ agentId: string; prompt: string; taskId: string }> = [];
    const start = mockStarter(created);

    const mentioned = await api.postToGroup(group.id, "@agent_b please review", "user", start);
    assert.equal(mentioned.targetAgentId, "agent_b");
    assert.equal(created[0]!.agentId, "agent_b");
    assert.match(created[0]!.prompt, /You are agent_b in this group chat/);
    assert.match(created[0]!.prompt, /@agent_b please review/);

    const fallback = await api.postToGroup(group.id, "no mention here", "user", start);
    assert.equal(fallback.targetAgentId, "agent_a");
    assert.equal(created[1]!.agentId, "agent_a");
  });

  it("collects an agent reply and starts the handoff target's task", async () => {
    const group = api.createGroup("Handoff", ["agent_a", "agent_b"]);
    const created: Array<{ agentId: string; prompt: string; taskId: string }> = [];
    const start = mockStarter(created);

    const posted = await api.postToGroup(group.id, "Investigate the failure", "user", start);
    const firstTaskId = posted.taskId!;
    assert.ok(firstTaskId);

    const handoff = api.recordHandoffForTask(firstTaskId, "agent_b", "Check the logs next");
    assert.equal(handoff.ok, true);
    assert.equal(handoff.agent!.id, "agent_b");

    db.completeTaskRun(firstTaskId, "I found a clue.", "test-model");
    const collected = await api.collectGroupReplies(start);
    assert.equal(collected, 1);

    const messages = api.listGroupMessages(group.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]!.author, "agent_a");
    assert.equal(messages[1]!.text, "I found a clue.");
    assert.equal(messages[1]!.handoffTo, "agent_b");
    assert.equal(messages[1]!.handoffNote, "Check the logs next");

    assert.equal(created.length, 2);
    assert.equal(created[1]!.agentId, "agent_b");
    assert.match(created[1]!.prompt, /handed this to you with the note: Check the logs next/);
    assert.match(created[1]!.prompt, /agent_a: I found a clue\./);

    // The next task is tracked for polling.
    const pending = api.listPendingGroupTasks();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.agentId, "agent_b");
  });

  it("rejects handoffs to agents outside the group", () => {
    const group = api.createGroup("Strict", ["agent_a"]);
    const created: Array<{ agentId: string; prompt: string; taskId: string }> = [];
    return api.postToGroup(group.id, "hi", "user", mockStarter(created)).then((posted) => {
      const result = api.recordHandoffForTask(posted.taskId!, "agent_zzz", "nope");
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /not a member/);
    });
  });

  it("handoff_to_agent refuses outside a group task and records inside one", async () => {
    const tool = tools.createGroupTools().find((t) => t.name === "handoff_to_agent");
    assert.ok(tool);
    const outside = await tool!.run({ agentName: "agent_b" }, {} as ToolContext);
    assert.equal(outside.ok, false);
    assert.match(outside.content, /only available inside a group task/);

    const group = api.createGroup("Tool", ["agent_a", "agent_b"]);
    const created: Array<{ agentId: string; prompt: string; taskId: string }> = [];
    const posted = await api.postToGroup(group.id, "start", "user", mockStarter(created));
    const inside = await tool!.run(
      { agentName: "agent_b", note: "your turn" },
      { taskId: posted.taskId! } as ToolContext,
    );
    assert.equal(inside.ok, true);
    assert.match(inside.content, /Handoff recorded to agent_b/);
    assert.equal(api.listPendingGroupTasks()[0]!.handoffTo, "agent_b");
  });
});
