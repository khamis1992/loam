/**
 * Lazy MCP bridge.
 *
 * A lazy server registers no per-tool schemas (the prompt stays cheap) and its
 * catalogue loads on first bridge use. Search, schema and call all reach the
 * tool; an unknown tool is a clean error.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolContext } from "../registry.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lazy-server.mjs");

test("a lazy server holds schemas out of the prompt and is reached through the bridge", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-mcp-"));
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  let cleanup: (() => void) | undefined;
  t.after(() => { cleanup?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const { ToolRegistry } = await import("../registry.js");
  const { registerMcpTools } = await import("../mcp.js");
  const registry = new ToolRegistry();
  const toolset = await registerMcpTools(registry, { lazy: { command: "node", args: [fixture], lazy: true } }, dataDir);
  cleanup = () => void toolset.close();

  assert.deepEqual(toolset.servers, ["lazy"]);
  assert.equal(registry.get("mcp__lazy__echo"), undefined, "lazy tools must not register eagerly");
  for (const name of ["mcp_list_servers", "mcp_search_tools", "mcp_tool_schema", "mcp_call_tool"]) {
    assert.ok(registry.get(name), `${name} must be registered`);
  }

  const ctx = { cfg: {}, workspace: dataDir, emit: () => {} } as unknown as ToolContext;

  const listed = await registry.get("mcp_list_servers")!.run({}, ctx);
  assert.match(listed.content, /"lazy": true/);

  const found = await registry.get("mcp_search_tools")!.run({ query: "echo" }, ctx);
  assert.equal(found.ok, true);
  assert.match(found.content, /lazy\/echo/);

  const schema = await registry.get("mcp_tool_schema")!.run({ server: "lazy", tool: "echo" }, ctx);
  assert.equal(schema.ok, true);
  assert.match(schema.content, /"text"/);

  const called = await registry.get("mcp_call_tool")!.run({ server: "lazy", tool: "echo", args: { text: "hello" } }, ctx);
  assert.equal(called.ok, true);
  assert.equal(called.content, "hello");

  const counted = await registry.get("mcp_call_tool")!.run({ server: "lazy", tool: "count", args: { text: "abcd" } }, ctx);
  assert.equal(counted.content, "4");

  const missing = await registry.get("mcp_tool_schema")!.run({ server: "lazy", tool: "nope" }, ctx);
  assert.equal(missing.ok, false);
});

test("eager servers keep registering individual schemas and add no bridge", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eager-mcp-"));
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  let cleanup: (() => void) | undefined;
  t.after(() => { cleanup?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const { ToolRegistry } = await import("../registry.js");
  const { registerMcpTools } = await import("../mcp.js");
  const registry = new ToolRegistry();
  const toolset = await registerMcpTools(registry, { eager: { command: "node", args: [fixture] } }, dataDir);
  cleanup = () => void toolset.close();

  assert.ok(registry.get("mcp__eager__echo"));
  assert.equal(registry.get("mcp_call_tool"), undefined);
});
