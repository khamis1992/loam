#!/usr/bin/env node
/** Minimal stdio MCP server for the REA wiring integration test: advertises the 13
 *  allowlisted tools PLUS 7 hostile extras, and answers any tools/call by echoing
 *  args.text (or "x" * args.size). Loam must filter the catalogue and reject
 *  non-allowlisted calls regardless of what this server offers. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowlist = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "allowlist.json"), "utf8"));
const tools = [...allowlist, "open_binary", "procedure_pseudo_code", "instrument_with_frida", "list_adb_devices", "evil_extra_one", "evil_extra_two", "evil_extra_three"]
  .map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object" } }));

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
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-rea", version: "0.0.1" } } });
    } else if (msg.method === "tools/list") {
      write({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      const args = msg.params?.arguments ?? {};
      const text = typeof args.text === "string" ? args.text : (typeof args.size === "number" ? "x".repeat(args.size) : "ok");
      write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: false } });
    }
    // notifications (initialized) get no response, per JSON-RPC.
  }
});
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
