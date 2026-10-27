import { isAllowedReTool } from "../re/allowlist.js";

/** REA MCP allowlist + static effects — REA_INTO_LOAM_INTEGRATION §4.7, §5.3–5.4, §7
 *  (spec copied to docs/senior-staff-engineer/specs/REA_INTO_LOAM_INTEGRATION.md, appendix A9).
 *  The server catalogue is never trusted: only these names may register, each with a
 *  Loam-side effects row so approval tiers never depend on server self-declaration.
 *  Names verified against the live rea catalogue 2026-10-24; `inspect_desktop_application`
 *  and `open_bundle_resources` from spec §5.3 were absent, so the list settles at 13. */

/** Pinned external package (OD-2). Exact version only — never a range, never `latest`. */
export const REA_MCP_SERVER = "rea";
export const REA_VERSION_PIN = "6.7.0";
/** npm registry integrity for rea-agents@6.7.0 (SRI); install script verifies against it. */
export const REA_NPM_INTEGRITY =
  "sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==";

export const REA_TOOL_ALLOWLIST = [
  "analyze_javascript_application",
  "inspect_artifact",
  "inspect_web_network_capture",
  "inspect_analysis_view",
  "compare_application_versions",
  "record_unknown",
  "update_unknown",
  "list_unknowns",
  "verify_unknown_resolution",
  "get_evidence_bundle",
  "export_evidence_bundle",
  "import_evidence_bundle",
  "recover_javascript_sources",
] as const;

export const REA_VISIBLE_TOOL_ALLOWLIST = REA_TOOL_ALLOWLIST.filter(isAllowedReTool);

export type ReaAllowedTool = (typeof REA_TOOL_ALLOWLIST)[number];

/** REA-style side-effect flags (spec §7.1). `mutatesSession` covers retained
 *  Evidence / unknowns state inside the MCP server; it is not a filesystem write. */
export interface ReaToolEffects {
  mutatesTarget: boolean;
  mutatesSession: boolean;
  writesFilesystem: boolean;
  launchesProcess: boolean;
  accessesNetwork: boolean;
  changesUiState: boolean;
  mayDiscardData: boolean;
  executesForeignCode: boolean;
  mutatesDevice: boolean;
  idempotent: boolean;
}

const READ_ONLY = (idempotent: boolean): ReaToolEffects => ({
  mutatesTarget: false, mutatesSession: false, writesFilesystem: false, launchesProcess: false,
  accessesNetwork: false, changesUiState: false, mayDiscardData: false, executesForeignCode: false,
  mutatesDevice: false, idempotent,
});
const SESSION_MUTATING = (idempotent: boolean): ReaToolEffects => ({ ...READ_ONLY(idempotent), mutatesSession: true });

/** Static effects per allowlisted tool. Subject binaries and apps are never executed;
 *  none of these tools accesses the network or mutates a device. */
export const REA_TOOL_EFFECTS: Record<ReaAllowedTool, ReaToolEffects> = {
  // Retains the application-graph Evidence inside the MCP session; reads target files only.
  analyze_javascript_application: SESSION_MUTATING(true),
  // Binds/inspects the active artifact (session state) without extracting or executing.
  inspect_artifact: SESSION_MUTATING(true),
  // Reads a local HAR/SAZ/qlog/mitmproxy capture and retains decoded records.
  inspect_web_network_capture: SESSION_MUTATING(true),
  // Pages retained Evidence — pure read.
  inspect_analysis_view: READ_ONLY(true),
  // Computes a delta over two retained graphs — pure read.
  compare_application_versions: READ_ONLY(true),
  // Unknowns ledger writes (session state).
  record_unknown: SESSION_MUTATING(false),
  update_unknown: SESSION_MUTATING(false),
  list_unknowns: READ_ONLY(true),
  verify_unknown_resolution: READ_ONLY(true),
  get_evidence_bundle: READ_ONLY(true),
  // Writes a canonical bundle JSON to a caller-chosen path.
  export_evidence_bundle: { ...READ_ONLY(false), writesFilesystem: true },
  // Reads a bundle file and merges records into the session.
  import_evidence_bundle: SESSION_MUTATING(false),
  // Writes recovered module files into an absent output directory.
  recover_javascript_sources: { ...READ_ONLY(false), writesFilesystem: true },
};

/** Filtered `tools/list` JSON must stay within this budget (small-model safety, §4.6). */
export const REA_CATALOGUE_BUDGET_BYTES = 200 * 1024;
/** Soft budget retained in agent context before the summary-first wrapper fires (§9). */
export const REA_RESULT_BUDGET_BYTES = 256 * 1024;
/** Hard cap for the paging tools before truncation with notice (§9). */
export const REA_RESULT_HARD_CAP_BYTES = 2 * 1024 * 1024;
/** Tools that page large payloads and therefore get the hard cap instead of the preview swap. */
export const REA_PAGING_TOOLS: ReadonlySet<string> = new Set(["inspect_analysis_view", "get_evidence_bundle", "list_unknowns"]);
/** Heavy analysis tools get a longer call timeout (§4.6); everything else uses the MCP default. */
export const REA_SLOW_TOOLS: ReadonlySet<string> = new Set([
  "analyze_javascript_application",
  "inspect_web_network_capture",
  "recover_javascript_sources",
]);
export const REA_SLOW_TIMEOUT_MS = 120_000;

export function isReaAllowedTool(name: string): name is ReaAllowedTool {
  return (REA_TOOL_ALLOWLIST as readonly string[]).includes(name);
}

export function filterReaTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((t) => isReaAllowedTool(t.name));
}

export function assertCatalogueBudget(filteredToolsJson: string): void {
  const n = Buffer.byteLength(filteredToolsJson, "utf8");
  if (n > REA_CATALOGUE_BUDGET_BYTES) {
    throw new Error(`rea allowlist catalogue is ${n} bytes; budget is ${REA_CATALOGUE_BUDGET_BYTES}`);
  }
}

/** MCP-style derived annotations (spec §7.2). */
export function annotationsFromEffects(v: ReaToolEffects): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  return {
    readOnlyHint: !(v.mutatesTarget || v.mutatesSession || v.writesFilesystem || v.launchesProcess ||
      v.accessesNetwork || v.changesUiState || v.mayDiscardData || v.executesForeignCode || v.mutatesDevice),
    destructiveHint: v.mayDiscardData || v.executesForeignCode || v.mutatesDevice,
    idempotentHint: v.idempotent,
    openWorldHint: v.launchesProcess || v.accessesNetwork,
  };
}

/** Map effects onto Loam's approval tiers (spec §7.2, repo tier names in riskTier.ts).
 *  Session-only mutation stays `read` — it never leaves the MCP server process. */
export function tierFromEffects(v: ReaToolEffects): "read" | "write-workspace" | "exec" | "network-external" | "destructive" {
  if (v.mayDiscardData || v.executesForeignCode || v.mutatesDevice || v.mutatesTarget) return "destructive";
  if (v.accessesNetwork) return "network-external";
  if (v.launchesProcess) return "exec";
  if (v.writesFilesystem) return "write-workspace";
  return "read";
}

export function reaToolEffects(name: string): ReaToolEffects | undefined {
  return isReaAllowedTool(name) ? REA_TOOL_EFFECTS[name] : undefined;
}

export function reaToolTier(name: string): "read" | "write-workspace" | "exec" | "network-external" | "destructive" | undefined {
  const effects = reaToolEffects(name);
  return effects ? tierFromEffects(effects) : undefined;
}

export function reaToolTimeoutMs(name: string): number {
  return REA_SLOW_TOOLS.has(name) ? REA_SLOW_TIMEOUT_MS : 30_000;
}
