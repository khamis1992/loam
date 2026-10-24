/** check:rea-allowlist — smoke gate for the REA allowlist module
 *  (REA_INTO_LOAM_INTEGRATION §5.3–5.4, §7; repo appendix A9).
 *  Proves: 13 verified names, complete effects coverage, derived tiers,
 *  catalogue budget enforcement, exact npm pin. Offline — no MCP server needed. */
import assert from "node:assert/strict";
import {
  REA_TOOL_ALLOWLIST,
  REA_TOOL_EFFECTS,
  REA_CATALOGUE_BUDGET_BYTES,
  REA_NPM_INTEGRITY,
  REA_MCP_SERVER,
  REA_VERSION_PIN,
  annotationsFromEffects,
  assertCatalogueBudget,
  filterReaTools,
  reaToolTier,
  tierFromEffects,
} from "../tools/reaAllowlist.js";

// 1. The allowlist is the exact verified set: 13 engine-free tools, spec §5.3 minus
//    the two names absent from the live catalogue (appendix A9).
assert.equal(REA_MCP_SERVER, "rea");
assert.equal(REA_TOOL_ALLOWLIST.length, 13);
assert.equal(new Set(REA_TOOL_ALLOWLIST).size, 13, "duplicate allowlist name");

// 2. A server advertising 40+ tools (full REA catalogue shape) collapses to exactly the allowlist.
const advertised = [
  ...REA_TOOL_ALLOWLIST.map((name) => ({ name, inputSchema: { type: "object" as const } })),
  ...["open_binary", "list_procedures", "procedure_pseudo_code", "instrument_with_frida", "list_adb_devices",
    "capture_browser_scenario", "extract_firmware", "inspect_macho", "xrefs", "search_bytes",
    "start_gdb_session", "cutter_command", "inspect_desktop_application", "open_bundle_resources",
    "analyze_javascript_application_twin"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
];
const filtered = filterReaTools(advertised);
assert.equal(filtered.length, 13);
assert.equal(filtered.every((t) => REA_TOOL_EFFECTS[t.name as keyof typeof REA_TOOL_EFFECTS] !== undefined), true);

// 3. Effects coverage: every name has a row; no tool touches network/process/device/target.
for (const name of REA_TOOL_ALLOWLIST) {
  const v = REA_TOOL_EFFECTS[name];
  assert.ok(v, `missing effects row: ${name}`);
  assert.equal(v.mutatesTarget || v.accessesNetwork || v.launchesProcess || v.mutatesDevice ||
    v.executesForeignCode || v.mayDiscardData, false, `unsafe flag on ${name}`);
  assert.equal(typeof reaToolTier(name), "string", `missing tier for ${name}`);
}

// 4. Tier derivation spot checks (spec §7.2): session-only read; the two writers escalate.
assert.equal(tierFromEffects(REA_TOOL_EFFECTS.analyze_javascript_application), "read");
assert.equal(reaToolTier("export_evidence_bundle"), "write-workspace");
assert.equal(reaToolTier("recover_javascript_sources"), "write-workspace");
assert.equal(reaToolTier("import_evidence_bundle"), "read");
const ann = annotationsFromEffects(REA_TOOL_EFFECTS.inspect_analysis_view);
assert.equal(ann.readOnlyHint && !ann.destructiveHint && !ann.openWorldHint, true);

// 5. Catalogue budget: compact filtered catalogue fits; oversized payload is rejected.
const compact = JSON.stringify(filtered);
assert.ok(Buffer.byteLength(compact, "utf8") <= REA_CATALOGUE_BUDGET_BYTES);
assert.doesNotThrow(() => assertCatalogueBudget(compact));
assert.throws(() => assertCatalogueBudget("x".repeat(REA_CATALOGUE_BUDGET_BYTES + 1)), /budget/);

// 6. Supply-chain pin shape (OD-2): exact semver + registry SRI recorded in-repo.
assert.match(REA_VERSION_PIN, /^\d+\.\d+\.\d+$/);
assert.match(REA_NPM_INTEGRITY, /^sha512-/);

console.log(`PASS: check:rea-allowlist — ${REA_TOOL_ALLOWLIST.length} pinned tools (rea-agents@${REA_VERSION_PIN}), full effects coverage, tiers derived, catalogue budget ${REA_CATALOGUE_BUDGET_BYTES}B enforced`);
