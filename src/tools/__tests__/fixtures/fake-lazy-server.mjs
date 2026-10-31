#!/usr/bin/env node
/** Minimal stdio MCP server for the lazy-bridge test: two tools, one of which
 *  echoes its `text` argument. The point is that a lazy server registers no
 *  per-tool schemas and is still reachable through the mcp_* bridge. */
const tools = [
  { name: "echo", description: "echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "count", description: "count characters", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
];

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-lazy", version: "0.0.1" } } });
    } else if (msg.method === "tools/list") {
      write({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      const args = msg.params?.arguments ?? {};
      const text = typeof args.text === "string" ? args.text : "";
      const out = msg.params?.name === "count" ? String(text.length) : text || "ok";
      write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: out }], isError: false } });
    }
  }
});
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
