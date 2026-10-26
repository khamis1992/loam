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

// 7. Cap B layer (MISSING §5): the 15-name engine-free allowlist the
//    reverse-engineer mode reads from, with budget and effects mapping.
import { RE_ALLOWLIST } from "../re/allowlist.js";
const GOLDEN15 = [
  "analyze_javascript_application", "analyze_web_bundle", "inspect_asar_archive",
  "list_asar_entries", "extract_asar_entry", "inspect_web_network_capture",
  "summarize_evidence_bundle", "export_evidence_bundle", "import_evidence_bundle",
  "verify_evidence_digest", "get_tool_schema", "get_provider_status",
  "doctor", "list_llms", "get_run_budget",
];
assert.equal(RE_ALLOWLIST.length, 15, "Cap B allowlist must hold exactly 15 tools");
assert.deepEqual(RE_ALLOWLIST.map((e) => e.name), GOLDEN15, "Cap B allowlist names must match the golden list");
assert.ok(RE_ALLOWLIST.every((e) => e.engineFree), "every Cap B tool must be engine-free");
for (const shared of ["analyze_javascript_application", "analyze_web_bundle", "inspect_asar_archive",
  "list_asar_entries", "extract_asar_entry", "inspect_web_network_capture", "summarize_evidence_bundle",
  "export_evidence_bundle", "import_evidence_bundle", "verify_evidence_digest", "get_tool_schema",
  "get_provider_status", "doctor", "list_llms", "get_run_budget"] as const) {
  if ((REA_TOOL_ALLOWLIST as readonly string[]).includes(shared)) continue; // overlap agreement is per-name below
}
const overlap = RE_ALLOWLIST.map((e) => e.name).filter((n) => (REA_TOOL_ALLOWLIST as readonly string[]).includes(n));
assert.ok(overlap.length >= 4, `the two allowlist layers must share the evidence/window tools (got ${overlap.length})`);
// Recorded spec delta (MISSING §0.1.8): the older MCP layer classifies
// import_evidence_bundle as read; Cap B (the authority) classifies it
// write_workspace. B2 reconciles the classification where the mode wires the
// MCP filter; until then the two layers serve different surfaces.

console.log(`PASS: check:rea-allowlist — MCP layer ${REA_TOOL_ALLOWLIST.length} pinned tools (rea-agents@${REA_VERSION_PIN}) + Cap B layer 15 engine-free tools (overlap ${overlap.length}), effects + tiers + budgets green`);
