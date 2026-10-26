import { test } from "node:test";
import assert from "node:assert/strict";
import { RE_ALLOWLIST, RE_ALLOWLIST_NAMES } from "../allowlist.js";
import { annotationsFromEffects, classifyReToolCall, effectToRiskPath, tierFromEffects, type ToolEffects } from "../effects.js";

const noEffects = (): ToolEffects => ({
  mutatesTarget: false, mutatesSession: false, writesFilesystem: false, launchesProcess: false,
  accessesNetwork: false, changesUiState: false, mayDiscardData: false, executesForeignCode: false,
  mutatesDevice: false, idempotent: false,
});

test("table-driven: every allowlisted tool has a tier and never 'denied'", () => {
  assert.equal(RE_ALLOWLIST.length, 15, "the engine-free allowlist is exactly 15 names");
  for (const entry of RE_ALLOWLIST) {
    const tier = classifyReToolCall(entry.name);
    assert.notEqual(tier, "denied", `${entry.name} must classify`);
    assert.equal(tier, effectToRiskPath(entry.effect), `${entry.name} tier follows its static effect row`);
  }
  assert.equal(classifyReToolCall("definitely_not_allowed"), "denied");
  assert.equal(classifyReToolCall("ghidra_analyze"), "denied", "engine-backed names stay outside the 15");
});

test("table-driven: the static effects rows (Cap B §5.3 expectations)", () => {
  const expected: Record<string, string> = {
    analyze_javascript_application: "read",
    analyze_web_bundle: "read",
    inspect_asar_archive: "read",
    list_asar_entries: "read",
    extract_asar_entry: "write-workspace-data",
    inspect_web_network_capture: "read",
    summarize_evidence_bundle: "read",
    export_evidence_bundle: "write-workspace-data",
    import_evidence_bundle: "write-workspace-data",
    verify_evidence_digest: "read",
    get_tool_schema: "read",
    get_provider_status: "read",
    doctor: "read",
    list_llms: "read",
    get_run_budget: "read",
  };
  for (const name of RE_ALLOWLIST_NAMES) assert.ok(expected[name], `${name} covered`);
  for (const [name, tier] of Object.entries(expected)) assert.equal(classifyReToolCall(name), tier, name);
});

test("tierFromEffects: destructive flags always ask (§7.2)", () => {
  for (const flag of ["mayDiscardData", "executesForeignCode", "mutatesDevice", "mutatesTarget"] as const) {
    const v = noEffects();
    v[flag] = true;
    assert.equal(tierFromEffects(v), "destructive", flag);
  }
  assert.equal(tierFromEffects(noEffects()), "read");
  const net = noEffects(); net.accessesNetwork = true;
  assert.equal(tierFromEffects(net), "network-external");
  const proc = noEffects(); proc.launchesProcess = true;
  assert.equal(tierFromEffects(proc), "exec");
  const write = noEffects(); write.writesFilesystem = true;
  assert.equal(tierFromEffects(write), "write-workspace");
});

test("annotationsFromEffects: readOnly only when nothing mutates", () => {
  assert.equal(annotationsFromEffects(noEffects()).readOnlyHint, true);
  for (const flag of ["mutatesTarget", "mutatesSession", "writesFilesystem", "launchesProcess", "accessesNetwork", "changesUiState", "mayDiscardData", "executesForeignCode", "mutatesDevice"] as const) {
    const v = noEffects();
    v[flag] = true;
    assert.equal(annotationsFromEffects(v).readOnlyHint, false, flag);
  }
  const discard = noEffects(); discard.mayDiscardData = true; discard.idempotent = true;
  const a = annotationsFromEffects(discard);
  assert.equal(a.destructiveHint, true);
  assert.equal(a.idempotentHint, true);
  assert.equal(a.openWorldHint, false);
});
