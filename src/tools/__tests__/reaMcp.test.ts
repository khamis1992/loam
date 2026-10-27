import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REA_TOOL_ALLOWLIST, REA_VISIBLE_TOOL_ALLOWLIST, REA_RESULT_BUDGET_BYTES } from "../reaAllowlist.js";

const fixtureServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-rea-server.mjs");

test("rea wiring: catalogue filtered to the allowlist, calls rejected outside it, results untrusted+budgeted, audit written", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rea-mcp-"));
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  let cleanup: (() => void) | undefined;
  t.after(() => { cleanup?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  // Import AFTER the data dir is pinned: mcp.ts resolves DATA_DIR at module load.
  const { ToolRegistry } = await import("../registry.js");
  const { registerMcpTools } = await import("../mcp.js");

  const registry = new ToolRegistry();
  const toolset = await registerMcpTools(registry, {
    rea: { command: "node", args: [fixtureServer], allowlist: [...REA_TOOL_ALLOWLIST] },
  }, dataDir);
  cleanup = () => void toolset.close();

  // 1. Only the engine-free allowlisted tools register; none of the hostile extras.
  assert.ok(toolset.servers.includes("rea"));
  const reaNames = registry.names().filter((n) => n.startsWith("mcp__rea__"));
  assert.equal(reaNames.length, REA_VISIBLE_TOOL_ALLOWLIST.length);
  for (const evil of ["mcp__rea__open_binary", "mcp__rea__evil_extra_one", "mcp__rea__instrument_with_frida"]) {
    assert.equal(registry.get(evil), undefined, `${evil} must not register`);
  }

  // 2. Direct callTool to a non-allowlisted name is rejected client-side (§5.4 defense in depth).
  const denied = await toolset.callTool("rea", "evil_extra_two", {});
  assert.equal(denied.ok, false);
  assert.match(denied.content, /not in the Loam REA allowlist/);

  // 3. An allowlisted call succeeds, is flagged untrusted, and carries a digest.
  const ok = await toolset.callTool("rea", "list_unknowns", { text: "small" });
  assert.equal(ok.ok, true);
  assert.equal(ok.untrusted, true);
  assert.match(ok.contentDigest ?? "", /^sha256_[a-f0-9]{32}$/);

  // 4. The summary-first budget swaps floods for a preview + next pointer (§9).
  //    (Paging tools keep payloads up to the hard cap — reaBudget.test covers that;
  //    here a non-paging tool must collapse to the structured preview.)
  const big = await toolset.callTool("rea", "record_unknown", { size: REA_RESULT_BUDGET_BYTES + 1 });
  assert.equal(big.ok, true);
  const parsed = JSON.parse(big.content) as { truncated: boolean; next: string };
  assert.equal(parsed.truncated, true);
  assert.match(parsed.next, /inspect_analysis_view/);

  // 5. Every call landed in the append-only audit log (§4.4).
  const auditFile = path.join(dataDir, "rea", "audit.jsonl");
  const entries = fs.readFileSync(auditFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l) as { name: string });
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("rea.mcp.connect"));
  assert.equal(names.filter((n) => n === "rea.mcp.call").length >= 3, true);

  // 6. Registry exec passes untrusted/contentDigest through (§8).
  const viaExec = await registry.exec("mcp__rea__analyze_javascript_application", { text: "direct" }, { workspace: dataDir } as never);
  assert.equal(viaExec.ok, true, viaExec.content);
  assert.equal(viaExec.untrusted, true);
  assert.match(viaExec.contentDigest ?? "", /^sha256_/);
});
