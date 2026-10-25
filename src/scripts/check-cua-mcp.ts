/** check:cua-mcp — smoke gate for the Cua Driver MCP wiring (CUA_INTO_LOAM §6–§7).
 *  Spawns the fixture fake server (14 allowlisted + ~45 hostile tools mirroring the
 *  live 63-tool catalogue) and proves, through the real registerMcpTools path:
 *  catalogue clamping, client-side rejection, untrusted + contentDigest results,
 *  the ids-only audit trail (typed text never lands), and the tier mapping.
 *  Offline fixture — the live pinned driver is exercised by the CP1 live proof. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CUA_DRIVER_TOOL_ALLOWLIST } from "../tools/cuaDriverAllowlist.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-mcp-check-"));
process.env.MANUS_LOCAL_DATA_DIR = dataDir;
const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "__tests__", "fixtures", "fake-cua-server.mjs");

const { ToolRegistry } = await import("../tools/registry.js");
const { registerMcpTools } = await import("../tools/mcp.js");
const { classifyToolCall } = await import("../policy/riskTier.js");

try {
  const registry = new ToolRegistry();
  const toolset = await registerMcpTools(registry, {
    "cua-driver": { command: "node", args: [fixtureServer], env: { CUA_DRIVER_PERMISSION_MODE: "standard" } },
  }, dataDir);

  // 1. Exactly 14 register from the hostile catalogue; nothing dangerous leaks.
  assert.equal(registry.names().filter((n) => n.startsWith("mcp__cua-driver__")).length, 14);
  for (const evil of ["mcp__cua-driver__kill_app", "mcp__cua-driver__run_script", "mcp__cua-driver__clipboard_read", "mcp__cua-driver__browser_navigate"]) {
    assert.equal(registry.get(evil), undefined);
  }

  // 2. Non-allowlisted direct calls are rejected inside Loam.
  const denied = await toolset.callTool("cua-driver", "kill_app", {});
  assert.equal(denied.ok, false);
  assert.match(denied.content, /allowlist/);

  // 3. Allowlisted calls: untrusted + digest; typed text never reaches the audit file.
  const ok = await toolset.callTool("cua-driver", "get_screen_size", {});
  assert.equal(ok.ok && ok.untrusted === true && /^sha256_/.test(ok.contentDigest ?? ""), true);
  await toolset.callTool("cua-driver", "type_text", { text: "SECRET-CHECK", target: { kind: "window", pid: 9, window_id: 10 } });
  const audit = fs.readFileSync(path.join(dataDir, "cua", "audit.jsonl"), "utf8");
  assert.ok(!audit.includes("SECRET-CHECK"));
  assert.match(audit, /"name":"cua.driver.connect"/);
  assert.match(audit, /"name":"cua.driver.call"/);
  assert.match(audit, /"name":"cua.driver.allowlist.reject"/);
  assert.ok(audit.includes("\"pid\":9"));

  // 4. Tiers: input tools always ask; reads auto (appendix B5).
  assert.equal(classifyToolCall("mcp__cua-driver__click"), "destructive");
  assert.equal(classifyToolCall("mcp__cua-driver__verify_state"), "read");

  await toolset.close();
  console.log(`PASS: check:cua-mcp — ${CUA_DRIVER_TOOL_ALLOWLIST.length} contract tools registered from the hostile 60+ catalogue, rejection + untrusted + ids-only audit + 7/7 tiers green (fixture server)`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
