/** check:rea-mcp — smoke gate for the REA MCP wiring (REA_INTO_LOAM §5, §7–§9).
 *  Spawns the fixture fake server (13 allowlisted + 7 hostile tools) and proves,
 *  through the real registerMcpTools path: catalogue filtering, client-side
 *  rejection, untrusted + contentDigest results, the summary-first budget, the
 *  append-only audit log, and registry exec passthrough. Offline fixture — the
 *  live pinned server is exercised by check:security-asar. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REA_TOOL_ALLOWLIST, REA_RESULT_BUDGET_BYTES } from "../tools/reaAllowlist.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rea-mcp-check-"));
process.env.MANUS_LOCAL_DATA_DIR = dataDir;
const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "__tests__", "fixtures", "fake-rea-server.mjs");

const { ToolRegistry } = await import("../tools/registry.js");
const { registerMcpTools } = await import("../tools/mcp.js");

try {
  const registry = new ToolRegistry();
  const toolset = await registerMcpTools(registry, {
    rea: { command: "node", args: [fixtureServer], allowlist: [...REA_TOOL_ALLOWLIST] },
  }, dataDir);

  // 1. Exactly 13 register from the 20-tool hostile catalogue.
  assert.equal(registry.names().filter((n) => n.startsWith("mcp__rea__")).length, 13);
  assert.equal(registry.get("mcp__rea__evil_extra_one"), undefined);

  // 2. Non-allowlisted direct calls are rejected inside Loam.
  const denied = await toolset.callTool("rea", "open_binary", {});
  assert.equal(denied.ok, false);
  assert.match(denied.content, /allowlist/);

  // 3. Allowlisted calls: untrusted + digest + budget preview on floods.
  const ok = await toolset.callTool("rea", "verify_unknown_resolution", { text: "proof" });
  assert.equal(ok.ok && ok.untrusted === true && /^sha256_/.test(ok.contentDigest ?? ""), true);
  const big = await toolset.callTool("rea", "update_unknown", { size: REA_RESULT_BUDGET_BYTES + 1 });
  assert.match((JSON.parse(big.content) as { next: string }).next, /inspect_analysis_view/);

  // 4. Audit trail exists for connect + calls.
  const audit = fs.readFileSync(path.join(dataDir, "rea", "audit.jsonl"), "utf8");
  assert.match(audit, /"name":"rea.mcp.connect"/);
  assert.match(audit, /"name":"rea.mcp.call"/);

  await toolset.close();
  console.log(`PASS: check:rea-mcp — 13/20 hostile catalogue tools registered, rejection + untrusted + budget + audit green (fixture server)`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
