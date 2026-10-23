/**
 * D12: managed session tools are registered with clear schemas and validate
 * their inputs before touching the registry.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";
import { ToolRegistry, type ToolContext } from "../registry.js";

const EXPECTED = [
  "managed_child_start",
  "managed_child_message",
  "managed_child_sleep",
  "managed_child_wake",
  "managed_child_terminate",
  "managed_child_answer",
  "managed_child_status",
  "managed_child_events",
  "schedule_self_reminder",
];

let tmpDir = "";
let closeDb: () => void;
let registry: ToolRegistry;
let ctx: ToolContext;

describe("managed session tools (D12)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-managed-tools-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = (await import("../../server/sqliteStore.js")) as unknown as { closeDb: () => void };
    closeDb = sqlite.closeDb;
    const mod = (await import("../managedSessionTools.js")) as unknown as {
      createManagedSessionTools: (deps: { ollama: unknown; parentRegistry: ToolRegistry }) => Array<{ name: string; description: string; parameters: Record<string, unknown>; run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ ok: boolean; content: string }> }>;
    };
    registry = new ToolRegistry();
    registry.registerAll(mod.createManagedSessionTools({ ollama: {}, parentRegistry: registry }));
    ctx = { cfg: {} as never, workspace: tmpDir, emit: () => {} };
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("registers every managed session tool with a description and JSON schema", () => {
    for (const name of EXPECTED) {
      const tool = registry.get(name);
      assert.ok(tool, `${name} must be registered`);
      assert.ok(tool!.description.length > 0, `${name} must have a description`);
      assert.equal(tool!.parameters.type, "object", `${name} must declare a JSON schema`);
    }
  });

  it("rejects tools when the run has no agent identity", async () => {
    const start = registry.get("managed_child_start")!;
    const res = await start.run({ childId: "agent_x", prompt: "hi" }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /requires a parent agent/);
  });

  it("rejects a message to an unknown managed child", async () => {
    const db = (await import("../../server/db.js")) as unknown as {
      createTask: (prompt: string, title?: string, projectId?: string | null, agentId?: string | null) => { id: string };
    };
    const agents = (await import("../../server/agents.js")) as unknown as {
      createAgent: (input: { name: string; instructions?: string }) => { id: string };
    };
    const parent = agents.createAgent({ name: "Coordinator", instructions: "coordinator" });
    const task = db.createTask("work", "task", null, parent.id);
    const message = registry.get("managed_child_message")!;
    const res = await message.run({ childId: "mchild_missing", message: "hi" }, { ...ctx, taskId: task.id });
    assert.equal(res.ok, false);
    assert.match(res.content, /unknown managed child/);
  });

  it("rejects a self reminder without a time", async () => {
    const db = (await import("../../server/db.js")) as unknown as {
      createTask: (prompt: string, title?: string, projectId?: string | null, agentId?: string | null) => { id: string };
    };
    const agents = (await import("../../server/agents.js")) as unknown as {
      createAgent: (input: { name: string; instructions?: string }) => { id: string };
    };
    const parent = agents.createAgent({ name: "Coordinator 2", instructions: "coordinator" });
    const task = db.createTask("work", "task", null, parent.id);
    const reminder = registry.get("schedule_self_reminder")!;
    const res = await reminder.run({ at: "", prompt: "check" }, { ...ctx, taskId: task.id });
    assert.equal(res.ok, false);
    assert.match(res.content, /requires both at and prompt/);
  });
});
