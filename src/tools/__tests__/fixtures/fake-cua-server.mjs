#!/usr/bin/env node
/** Minimal stdio MCP server for the Cua Driver wiring integration test: mirrors the
 *  live driver's 63-tool catalogue (contract 29 + skill extras incl. kill_app /
 *  run_script / browser_*), and answers tools/call by echoing args.text (or "ok").
 *  Loam must clamp the catalogue to the 14 allowlisted names and reject everything
 *  else regardless of what this server offers. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowlist = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "cua-allowlist.json"), "utf8"));
const extras = [
  "clipboard_read", "clipboard_write", "drag", "move_cursor", "parse_visual_regions", "set_window_frame",
  "escalate_session", "set_agent_cursor_theme", "set_agent_cursor_motion", "get_session_state",
  "list_sessions", "get_agent_cursor_state", "get_cursor_position", "launch_app", "run_script",
  "run_steps", "kill_app", "replay_trajectory", "browser_navigate", "browser_click", "start_recording",
  "install_extension", "set_config", "get_config", "check_for_update", "zoom", "page", "double_click",
  "right_click", "bring_to_front", "set_value", "get_accessibility_tree", "health_report", "get_guide",
  "debug_window_info", "check_permissions", "install_ffmpeg", "get_recording_state", "stop_recording",
  "start_recording", "get_browser_state", "browser_type", "browser_prepare", "browser_pointer",
  "browser_dialog", "browser_download", "browser_select", "browser_set_input_files", "invoke_menu2",
];
const tools = [...allowlist, ...extras].map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object" } }));

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
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-cua-driver", version: "0.0.1" } } });
    } else if (msg.method === "tools/list") {
      write({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      const args = msg.params?.arguments ?? {};
      write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: typeof args.text === "string" ? args.text : "ok" }], isError: false } });
    }
  }
});
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
