import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CUA_DRIVER_TOOL_ALLOWLIST } from "../cuaDriverAllowlist.js";

const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cua-server.mjs");

test("cua wiring: 63-tool hostile catalogue clamps to 14, calls rejected outside, results untrusted, audit written", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-mcp-"));
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  let cleanup: (() => void) | undefined;
  t.after(() => { cleanup?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  // Import AFTER the data dir is pinned: mcp.ts resolves DATA_DIR at module load.
  const { ToolRegistry } = await import("../registry.js");
  const { registerMcpTools } = await import("../mcp.js");

  const registry = new ToolRegistry();
  const toolset = await registerMcpTools(registry, {
    "cua-driver": { command: "node", args: [fixtureServer], env: { CUA_DRIVER_PERMISSION_MODE: "standard" } },
  }, dataDir);
  cleanup = () => void toolset.close();

  // 1. Exactly the 14 contract tools register from the 60+ tool hostile catalogue.
  assert.ok(toolset.servers.includes("cua-driver"));
  const names = registry.names().filter((n) => n.startsWith("mcp__cua-driver__"));
  assert.equal(names.length, CUA_DRIVER_TOOL_ALLOWLIST.length);
  for (const evil of ["mcp__cua-driver__kill_app", "mcp__cua-driver__run_script", "mcp__cua-driver__clipboard_read", "mcp__cua-driver__browser_navigate", "mcp__cua-driver__launch_app"]) {
    assert.equal(registry.get(evil), undefined, `${evil} must not register`);
  }

  // 2. Direct callTool to non-allowlisted names is rejected client-side (§7.4).
  const denied = await toolset.callTool("cua-driver", "clipboard_read", {});
  assert.equal(denied.ok, false);
  assert.match(denied.content, /not in the Loam Cua Driver allowlist/);
  const deniedKill = await toolset.callTool("cua-driver", "kill_app", { target: { kind: "window", pid: 1, window_id: 2 } });
  assert.equal(deniedKill.ok, false);

  // 3. Allowlisted read call succeeds, flagged untrusted with a digest.
  const ok = await toolset.callTool("cua-driver", "list_windows", {});
  assert.equal(ok.ok, true);
  assert.equal(ok.untrusted, true);
  assert.match(ok.contentDigest ?? "", /^sha256_[a-f0-9]{32}$/);

  // 4. Audit trail: connect + calls + rejects, ids only (typed text never lands).
  const auditFile = path.join(dataDir, "cua", "audit.jsonl");
  const raw = fs.readFileSync(auditFile, "utf8");
  assert.match(raw, /"name":"cua.driver.connect"/);
  assert.match(raw, /"name":"cua.driver.call"/);
  assert.match(raw, /"name":"cua.driver.allowlist.reject"/);
  // A typed-text call must be audited without its text.
  const typed = await toolset.callTool("cua-driver", "type_text", { text: "SECRET-PAIRING-CODE", target: { kind: "window", pid: 77, window_id: 88 } });
  assert.equal(typed.ok, true);
  const after = fs.readFileSync(auditFile, "utf8");
  assert.ok(!after.includes("SECRET-PAIRING-CODE"), "typed text must never reach the audit log");
  assert.ok(after.includes("\"pid\":77") && after.includes("\"windowId\":88"));

  // 5. Registry exec passes untrusted/contentDigest through (§6.2).
  const viaExec = await registry.exec("mcp__cua-driver__list_windows", {}, { workspace: dataDir } as never);
  assert.equal(viaExec.ok, true);
  assert.equal(viaExec.untrusted, true);
  assert.match(viaExec.contentDigest ?? "", /^sha256_/);
});

test("risk tiers: host input tools classify destructive (never auto-approved); reads are read", async () => {
  const { classifyToolCall } = await import("../../policy/riskTier.js");
  assert.equal(classifyToolCall("mcp__cua-driver__click"), "destructive");
  assert.equal(classifyToolCall("mcp__cua-driver__type_text"), "destructive");
  assert.equal(classifyToolCall("mcp__cua-driver__hotkey"), "destructive");
  assert.equal(classifyToolCall("mcp__cua-driver__invoke_menu"), "destructive");
  assert.equal(classifyToolCall("mcp__cua-driver__end_session"), "destructive");
  assert.equal(classifyToolCall("mcp__cua-driver__list_windows"), "read");
  assert.equal(classifyToolCall("mcp__cua-driver__get_window_state"), "read");
  assert.equal(classifyToolCall("mcp__cua-driver__verify_state"), "read");
  assert.equal(classifyToolCall("mcp__cua-driver__start_session"), "read");
  // Untabled name → fail-safe review tier.
  assert.equal(classifyToolCall("mcp__cua-driver__kill_app"), "exec");
});
