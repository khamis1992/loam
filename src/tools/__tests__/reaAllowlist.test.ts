import assert from "node:assert/strict";
import test from "node:test";
import {
  REA_TOOL_ALLOWLIST,
  REA_TOOL_EFFECTS,
  REA_CATALOGUE_BUDGET_BYTES,
  REA_NPM_INTEGRITY,
  REA_VERSION_PIN,
  REA_PAGING_TOOLS,
  REA_RESULT_HARD_CAP_BYTES,
  REA_RESULT_BUDGET_BYTES,
  annotationsFromEffects,
  assertCatalogueBudget,
  filterReaTools,
  isReaAllowedTool,
  reaToolEffects,
  reaToolTier,
  reaToolTimeoutMs,
  tierFromEffects,
  type ReaToolEffects,
} from "../reaAllowlist.js";

test("allowlist is exactly the 13 verified engine-free tools", () => {
  assert.equal(REA_TOOL_ALLOWLIST.length, 13);
  // Spec §5.3 names that the live catalogue does not expose must not appear (appendix A9).
  assert.equal(isReaAllowedTool("inspect_desktop_application"), false);
  assert.equal(isReaAllowedTool("open_bundle_resources"), false);
  // Engine-adjacent surfaces stay out even though the server offers them.
  for (const banned of ["open_binary", "procedure_pseudo_code", "list_procedures", "instrument_with_frida", "list_adb_devices"]) {
    assert.equal(isReaAllowedTool(banned), false);
  }
});

test("every allowlisted tool has a static effects row and a derived tier", () => {
  for (const name of REA_TOOL_ALLOWLIST) {
    const effects = reaToolEffects(name);
    assert.ok(effects, `missing effects row: ${name}`);
    assert.ok(reaToolTier(name), `missing tier: ${name}`);
    assert.equal(reaToolTimeoutMs(name) > 0, true);
  }
  // Record completeness is compile-time via Record<ReaAllowedTool, …>; sanity-check size.
  assert.equal(Object.keys(REA_TOOL_EFFECTS).length, REA_TOOL_ALLOWLIST.length);
});

test("filterReaTools drops everything outside the allowlist", () => {
  const advertised = [
    ...REA_TOOL_ALLOWLIST.map((name) => ({ name })),
    { name: "open_binary" },
    { name: "instrument_with_frida" },
    { name: "capture_browser_scenario" },
    { name: "analyze_javascript_application_evil_twin" },
  ];
  const filtered = filterReaTools(advertised);
  assert.equal(filtered.length, REA_TOOL_ALLOWLIST.length);
  assert.deepEqual(new Set(filtered.map((t) => t.name)), new Set<string>(REA_TOOL_ALLOWLIST));
});

test("no allowlisted tool mutates a target, device, network, or executes foreign code", () => {
  for (const name of REA_TOOL_ALLOWLIST) {
    const v = REA_TOOL_EFFECTS[name];
    assert.equal(v.mutatesTarget, false, name);
    assert.equal(v.mutatesDevice, false, name);
    assert.equal(v.accessesNetwork, false, name);
    assert.equal(v.executesForeignCode, false, name);
    assert.equal(v.mayDiscardData, false, name);
    assert.equal(v.launchesProcess, false, name);
  }
});

test("tierFromEffects: session-only is read, filesystem writes escalate, destructive flags are destructive", () => {
  const sessionOnly: ReaToolEffects = {
    mutatesTarget: false, mutatesSession: true, writesFilesystem: false, launchesProcess: false,
    accessesNetwork: false, changesUiState: false, mayDiscardData: false, executesForeignCode: false,
    mutatesDevice: false, idempotent: true,
  };
  assert.equal(tierFromEffects(sessionOnly), "read");
  assert.equal(tierFromEffects({ ...sessionOnly, writesFilesystem: true }), "write-workspace");
  assert.equal(tierFromEffects({ ...sessionOnly, launchesProcess: true }), "exec");
  assert.equal(tierFromEffects({ ...sessionOnly, accessesNetwork: true }), "network-external");
  assert.equal(tierFromEffects({ ...sessionOnly, mayDiscardData: true }), "destructive");
  assert.equal(tierFromEffects({ ...sessionOnly, mutatesTarget: true }), "destructive");
});

test("derived tiers match the expected v1 split (11 read / 2 write-workspace)", () => {
  const tiers = REA_TOOL_ALLOWLIST.map((name) => reaToolTier(name));
  const reads = tiers.filter((t) => t === "read").length;
  const writes = tiers.filter((t) => t === "write-workspace").length;
  assert.equal(reads, 11);
  assert.equal(writes, 2);
  assert.equal(reaToolTier("export_evidence_bundle"), "write-workspace");
  assert.equal(reaToolTier("recover_javascript_sources"), "write-workspace");
  assert.equal(reaToolTier("import_evidence_bundle"), "read");
});

test("annotationsFromEffects marks analysis tools read-only and export not read-only", () => {
  const view = annotationsFromEffects(REA_TOOL_EFFECTS.inspect_analysis_view);
  assert.equal(view.readOnlyHint, true);
  assert.equal(view.destructiveHint, false);
  assert.equal(view.openWorldHint, false);
  const exportBundle = annotationsFromEffects(REA_TOOL_EFFECTS.export_evidence_bundle);
  assert.equal(exportBundle.readOnlyHint, false);
  assert.equal(exportBundle.destructiveHint, false);
});

test("assertCatalogueBudget enforces the 200 KiB budget", () => {
  const within = JSON.stringify(REA_TOOL_ALLOWLIST.map((name) => ({ name, inputSchema: { type: "object" } })));
  assert.ok(Buffer.byteLength(within, "utf8") <= REA_CATALOGUE_BUDGET_BYTES);
  assert.doesNotThrow(() => assertCatalogueBudget(within));
  const oversized = JSON.stringify({ name: "x", description: "y".repeat(REA_CATALOGUE_BUDGET_BYTES) });
  assert.throws(() => assertCatalogueBudget(oversized), /budget/);
});

test("pin metadata: exact version and registry SRI integrity", () => {
  assert.match(REA_VERSION_PIN, /^\d+\.\d+\.\d+$/);
  assert.match(REA_NPM_INTEGRITY, /^sha512-[A-Za-z0-9+/]{80,}={0,2}$/);
});

test("result budgets are ordered and paging tools opt into the hard cap", () => {
  assert.ok(REA_RESULT_BUDGET_BYTES < REA_RESULT_HARD_CAP_BYTES);
  assert.ok(REA_PAGING_TOOLS.size >= 3);
  for (const name of REA_PAGING_TOOLS) assert.ok(isReaAllowedTool(name), `paging tool not allowlisted: ${name}`);
});

test("slow analysis tools get the 120s timeout, session tools the 30s default", () => {
  assert.equal(reaToolTimeoutMs("analyze_javascript_application"), 120_000);
  assert.equal(reaToolTimeoutMs("inspect_web_network_capture"), 120_000);
  assert.equal(reaToolTimeoutMs("recover_javascript_sources"), 120_000);
  assert.equal(reaToolTimeoutMs("list_unknowns"), 30_000);
  assert.equal(reaToolTimeoutMs("export_evidence_bundle"), 30_000);
});
