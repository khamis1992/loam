import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mcp-policy-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;
process.env.LOAM_CONFIG = path.join(dir, "config.json");
fs.writeFileSync(process.env.LOAM_CONFIG, JSON.stringify({
  workspace: dir,
  mcpServers: {
    local: { command: "node" },
    remote: { transport: "http", url: "https://example.com/mcp" },
  },
}));

const agents = await import("../agents.js");
const db = await import("../db.js");
const policy = await import("../mcpPolicy.js");
const { loadConfig } = await import("../../config.js");
const sqlite = await import("../sqliteStore.js");
policy.setMcpAgentResolver((ctx) => {
  const task = ctx.taskId ? db.getTask(ctx.taskId) : undefined;
  const agentId = task?.agentId ?? ctx.agentId;
  return agentId ? agents.getAgent(agentId) : undefined;
});

after(() => {
  sqlite.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP agent and execution-target policy", () => {
  it("never exposes host stdio tools in own-device mode and honors HTTP grants", () => {
    const agent = agents.createAgent({
      name: "Remote Only",
      workMode: "own_device",
      connectorGrants: [{ connectorId: "remote", permissions: ["read"] }],
    });
    const task = db.createTask("remote work", "remote work", null, agent.id);
    const ctx = { cfg: loadConfig(), workspace: dir, emit: () => {}, taskId: task.id };

    assert.equal(policy.hasExplicitMcpGrant(ctx, "remote"), true);
    assert.equal(policy.hasExplicitMcpGrant(ctx, "local"), false);
    assert.equal(policy.isMcpExecutionAllowed(ctx, "remote"), true);
    assert.equal(policy.isMcpExecutionAllowed(ctx, "local"), false);
    assert.deepEqual(
      policy.filterMcpToolsForWorkMode(["mcp__local__run", "mcp__remote__run", "mcp_call_tool", "mcp_search_tools"], "own_device", loadConfig().mcpServers),
      ["mcp__remote__run", "mcp_search_tools"],
    );
  });

  it("treats an empty grant list as a complete connector revocation", () => {
    const agent = agents.createAgent({ name: "No MCP", connectorGrants: [] });
    const task = db.createTask("no mcp", "no mcp", null, agent.id);
    const ctx = { cfg: loadConfig(), workspace: dir, emit: () => {}, taskId: task.id };
    assert.equal(policy.isMcpExecutionAllowed(ctx, "remote"), false);
  });
});
