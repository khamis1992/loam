/**
 * MF6: persistent child agents — spawn idempotency, listing and delegation.
 *
 * The data directory is isolated like the scratchpad test: the env var must be
 * set BEFORE the modules that read it (config.ts → DATA_DIR) are imported, so
 * every runtime import below is dynamic.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

interface AgentSpawnApi {
  spawnAgent: (input: {
    parentAgentId: string;
    spawnKey: string;
    name: string;
    instructions: string;
    description?: string;
    emoji?: string;
    mode?: string;
  }) => { childId: string; created: boolean };
  listChildren: (parentAgentId: string) => Array<{ childId: string; spawnKey: string; name: string; emoji: string; archived: boolean; createdAt: string }>;
  delegateToChild: (
    input: { parentAgentId: string; childId: string; prompt: string; timeoutSeconds?: number; title?: string },
    opts?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; taskId?: string; content: string; status?: string; error?: string }>;
  isChildOf: (parentAgentId: string, childAgentId: string) => boolean;
  spawnRecordId: (parentAgentId: string, spawnKey: string) => string;
}

interface AgentsApi {
  createAgent: (input: { name: string; instructions?: string }) => { id: string; name: string };
  getAgent: (id: string) => { id: string; name: string } | undefined;
  deleteAgent: (id: string) => boolean;
}

interface DbApi {
  createTask: (prompt: string, title?: string, projectId?: string | null, agentId?: string | null) => { id: string };
  appendMessage: (id: string, role: "user" | "assistant" | "system", content: string) => void;
  setTaskStatus: (id: string, status: "queued" | "running" | "done" | "error" | "interrupted" | "cancelled", extra?: { model?: string; error?: string }) => void;
}

interface CompanionTeamApi {
  setDelegationRunner: (runner?: (req: { toAgentId: string; brief: string; fromAgentId: string }) => Promise<{ taskId: string; queued: boolean; error?: string }>) => void;
}

interface SqliteApi {
  closeDb: () => void;
  getEntity: <T>(kind: string, id: string) => T | undefined;
}

let tmpDir = "";
let closeDb: () => void;
let getEntity: <T>(kind: string, id: string) => T | undefined;
let api: AgentSpawnApi;
let agentsApi: AgentsApi;
let dbApi: DbApi;
let teamApi: CompanionTeamApi;

describe("agent spawn (MF6)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agentspawn-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = (await import("../sqliteStore.js")) as unknown as SqliteApi;
    closeDb = sqlite.closeDb;
    getEntity = sqlite.getEntity;
    const spawn = (await import("../agentSpawn.js")) as unknown as AgentSpawnApi;
    const agents = (await import("../agents.js")) as unknown as AgentsApi;
    const db = (await import("../db.js")) as unknown as DbApi;
    const team = (await import("../companionTeam.js")) as unknown as CompanionTeamApi;
    api = {
      spawnAgent: spawn.spawnAgent,
      listChildren: spawn.listChildren,
      delegateToChild: spawn.delegateToChild,
      isChildOf: spawn.isChildOf,
      spawnRecordId: spawn.spawnRecordId,
    };
    agentsApi = agents;
    dbApi = db;
    teamApi = team;
  });

  after(() => {
    teamApi.setDelegationRunner(undefined);
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("spawning the same key twice returns the same child agent", () => {
    const parent = agentsApi.createAgent({ name: "Parent", instructions: "parent" });
    const first = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "researcher", name: "Researcher", instructions: "look things up" });
    assert.equal(first.created, true);
    assert.ok(first.childId.startsWith("agent_"));

    const second = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "researcher", name: "Researcher", instructions: "look things up" });
    assert.equal(second.created, false);
    assert.equal(second.childId, first.childId);

    const children = api.listChildren(parent.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.childId, first.childId);
    assert.equal(children[0]!.spawnKey, "researcher");
    assert.equal(children[0]!.name, "Researcher");
    assert.equal(children[0]!.archived, false);

    // The linkage is persisted, not just in memory.
    const record = getEntity<{ childAgentId: string; parentAgentId: string }>("agent_spawns", api.spawnRecordId(parent.id, "researcher"));
    assert.ok(record);
    assert.equal(record!.childAgentId, first.childId);
    assert.equal(record!.parentAgentId, parent.id);
  });

  it("different spawn keys create different children", () => {
    const parent = agentsApi.createAgent({ name: "Parent 2", instructions: "parent" });
    const a = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "alpha", name: "Alpha", instructions: "a" });
    const b = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "beta", name: "Beta", instructions: "b" });
    assert.notEqual(a.childId, b.childId);
    assert.equal(api.listChildren(parent.id).length, 2);
    assert.equal(api.isChildOf(parent.id, a.childId), true);
  });

  it("a deleted child is revived under the same spawn key", () => {
    const parent = agentsApi.createAgent({ name: "Parent 3", instructions: "parent" });
    const first = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "worker", name: "Worker", instructions: "work" });
    assert.equal(api.listChildren(parent.id).length, 1);
    agentsApi.deleteAgent(first.childId);
    assert.equal(api.listChildren(parent.id).length, 0);

    const revived = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "worker", name: "Worker", instructions: "work" });
    assert.equal(revived.created, true);
    assert.notEqual(revived.childId, first.childId);
    const children = api.listChildren(parent.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.childId, revived.childId);
  });

  it("rejects an unknown parent, an empty key and an unknown mode", () => {
    assert.throws(() => api.spawnAgent({ parentAgentId: "agent_missing", spawnKey: "k", name: "X", instructions: "" }), /parent agent not found/);
    const parent = agentsApi.createAgent({ name: "Parent 4", instructions: "parent" });
    assert.throws(() => api.spawnAgent({ parentAgentId: parent.id, spawnKey: "   ", name: "X", instructions: "" }), /spawn key is required/);
    assert.throws(() => api.spawnAgent({ parentAgentId: parent.id, spawnKey: "k", name: "X", instructions: "", mode: "not-a-mode" }), /Unknown Loam mode/);
  });

  it("delegation returns the child's final answer to the parent", async () => {
    const parent = agentsApi.createAgent({ name: "Parent 5", instructions: "parent" });
    const child = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "child", name: "Child", instructions: "child" });
    teamApi.setDelegationRunner(async (req) => {
      const task = dbApi.createTask(req.brief, "child task", null, req.toAgentId);
      dbApi.appendMessage(task.id, "assistant", "the child answer");
      dbApi.setTaskStatus(task.id, "done");
      return { taskId: task.id, queued: true };
    });

    const res = await api.delegateToChild({ parentAgentId: parent.id, childId: child.childId, prompt: "do the thing" });
    assert.equal(res.ok, true);
    assert.equal(res.content, "the child answer");
    assert.equal(res.status, "done");
    assert.ok(res.taskId);
  });

  it("refuses to delegate to an agent that is not a child", async () => {
    const parent = agentsApi.createAgent({ name: "Parent 6", instructions: "parent" });
    const stranger = agentsApi.createAgent({ name: "Stranger", instructions: "stranger" });
    teamApi.setDelegationRunner(async () => ({ taskId: "task_x", queued: true }));
    const res = await api.delegateToChild({ parentAgentId: parent.id, childId: stranger.id, prompt: "hi" });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /is not a child of/);
  });

  it("reports a timeout when the child never finishes", async () => {
    const parent = agentsApi.createAgent({ name: "Parent 7", instructions: "parent" });
    const child = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "slow", name: "Slow", instructions: "child" });
    teamApi.setDelegationRunner(async (req) => ({ taskId: dbApi.createTask(req.brief, "stuck", null, req.toAgentId).id, queued: true }));
    const res = await api.delegateToChild({ parentAgentId: parent.id, childId: child.childId, prompt: "wait", timeoutSeconds: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.status, "timeout");
    assert.match(String(res.error), /did not finish within 1s/);
  });

  it("reports a cancellation when the run signal aborts", async () => {
    const parent = agentsApi.createAgent({ name: "Parent 8", instructions: "parent" });
    const child = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "cancelled", name: "Cancelled", instructions: "child" });
    teamApi.setDelegationRunner(async (req) => ({ taskId: dbApi.createTask(req.brief, "stuck", null, req.toAgentId).id, queued: true }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const res = await api.delegateToChild({ parentAgentId: parent.id, childId: child.childId, prompt: "wait", timeoutSeconds: 30 }, { signal: controller.signal });
    assert.equal(res.ok, false);
    assert.equal(res.status, "cancelled");
  });

  it("fails honestly when no delegation engine is wired", async () => {
    const parent = agentsApi.createAgent({ name: "Parent 9", instructions: "parent" });
    const child = api.spawnAgent({ parentAgentId: parent.id, spawnKey: "engine", name: "Engine", instructions: "child" });
    teamApi.setDelegationRunner(undefined);
    const res = await api.delegateToChild({ parentAgentId: parent.id, childId: child.childId, prompt: "hi" });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /delegation engine is not available/);
  });
});
