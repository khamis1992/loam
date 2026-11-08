import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type http from "node:http";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "__tests__", "fixtures", "fake-lazy-server.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mcp-routes-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;
process.env.LOAM_ROOT = dir;
process.env.LOAM_CONFIG = path.join(dir, "config.json");
process.env.LOAM_AUTH_DISABLED = "true";

let server: http.Server;
let closeDb: () => void;
let closeMcp: (() => Promise<void>) | undefined;
let base = "";

before(async () => {
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(process.env.LOAM_CONFIG!, JSON.stringify({ workspace, memory: { enabled: false }, screen: { enabled: false }, mcpServers: {} }));
  const { loadConfig } = await import("../../config.js");
  const { OllamaClient } = await import("../../ollama.js");
  const { startServer } = await import("../http.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  const { registerMcpTools } = await import("../../tools/mcp.js");
  const { readMcpServers } = await import("../mcpConfig.js");
  const registry = new ToolRegistry();
  let current: import("../../tools/mcp.js").McpToolset | null = null;
  closeMcp = async () => { await current?.close(); };
  const cfg = loadConfig();
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0;
  server = await startServer({
    cfg,
    ollama: new OllamaClient("http://127.0.0.1:1"),
    registry,
    runTask: async () => ({ taskId: "test", text: "" }),
    reloadMcp: async () => {
      await current?.close();
      for (const name of registry.names()) {
        if (name.startsWith("mcp__") || ["mcp_list_servers", "mcp_search_tools", "mcp_tool_schema", "mcp_call_tool"].includes(name)) registry.unregister(name);
      }
      current = await registerMcpTools(registry, readMcpServers(), workspace);
      return current;
    },
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  closeDb = (await import("../sqliteStore.js")).closeDb;
});

after(async () => {
  await closeMcp?.();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface CreatedServerBody {
  server: {
    accountName: string;
    headers?: Record<string, string>;
    headerNames: string[];
    runtime: { connected: boolean };
  };
}

interface ToolsBody {
  tools: Array<{ name: string; description: string }>;
}

async function call<T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as T };
}

describe("MCP server management HTTP API", () => {
  it("creates, discovers, disables and removes a real stdio server", async () => {
    try {
    const created = await call<CreatedServerBody>("POST", "/api/mcp/servers", {
      name: "lazy-test",
      config: { command: "node", args: [fixture], lazy: true, accountName: "Test Account", customInstructions: "Use concise replies", headers: { "x-test-secret": "not-a-real-secret" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.server.accountName, "Test Account");
    assert.equal(created.body.server.headers, undefined);
    assert.deepEqual(created.body.server.headerNames, ["x-test-secret"]);
    assert.equal(created.body.server.runtime.connected, true, JSON.stringify(created.body));

    const tools = await call<ToolsBody>("GET", "/api/mcp/servers/lazy-test/tools");
    assert.equal(tools.status, 200);
    assert.ok(tools.body.tools.some((tool: { name: string }) => tool.name === "echo"));
    assert.match(tools.body.tools[0]!.description, /Server instructions: Use concise replies/);

    const disabled = await call("PUT", "/api/mcp/servers/lazy-test/tools", { disabledTools: ["echo"] });
    assert.equal(disabled.status, 200);
    const remaining = await call<ToolsBody>("GET", "/api/mcp/servers/lazy-test/tools");
    assert.equal(remaining.body.tools.some((tool: { name: string }) => tool.name === "echo"), false);

    const removed = await call("DELETE", "/api/mcp/servers/lazy-test");
    assert.equal(removed.status, 200);
    const listed = await call<{ servers: unknown[] }>("GET", "/api/mcp/servers");
    assert.equal(listed.body.servers.length, 0);
    } catch (error) {
      console.error("MCP route stage failed", error);
      throw error;
    }
  });

  it("installs a service pack through the real reload path", async () => {
    const installed = await call<{ server: { name: string; servicePackId: string; runtime: { connected: boolean } } }>("POST", "/api/service-packs", {
      id: "slack",
      name: "slack-test",
      config: { command: "node", args: [fixture], accountName: "Slack Test" },
    });
    assert.equal(installed.status, 201, JSON.stringify(installed.body));
    assert.equal(installed.body.server.servicePackId, "slack");
    assert.equal(installed.body.server.runtime.connected, true);

    const listed = await call<{ packs: Array<{ id: string; installed: Array<{ name: string }> }> }>("GET", "/api/service-packs");
    const slack = listed.body.packs.find((pack) => pack.id === "slack");
    assert.equal(slack?.installed[0]?.name, "slack-test");
    await call("DELETE", "/api/mcp/servers/slack-test");
  });
});
