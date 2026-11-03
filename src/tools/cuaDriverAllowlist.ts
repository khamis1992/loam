/** Cua Driver MCP allowlist + static effects — CUA_INTO_LOAM_INTEGRATION §6.7, §7.3–§7.4
 *  (spec copied to docs/senior-staff-engineer/specs/CUA_INTO_LOAM_INTEGRATION.md, appendix B).
 *  The driver catalogue is never trusted: only these 14 contract-backed names may
 *  register, each with a Loam-side effects row so approval tiers never depend on
 *  server self-declaration. Clipboard, drag, perception, window-frame and agent-cursor
 *  tools stay out of v1 (OD-5); the driver is the ONLY cua piece in scope (no Spaces/
 *  FSL, no Lume, no AGPL perception — skip list §1.2). */

/** Pinned external binary (OD-3). Exact release + sha256, recorded live from the
 *  GitHub API on 2026-10-25 (appendix B8, resolves spec U1). Never `@latest`. */
export const CUA_DRIVER_MCP_SERVER = "cua-driver";
export const CUA_DRIVER_VERSION_PIN = "0.38.0";
export const CUA_DRIVER_RELEASE_TAG = "cua-driver-rs-v0.38.0";
export const CUA_DRIVER_ASSET = "cua-driver-rs-0.38.0-windows-x86_64.zip";
export const CUA_DRIVER_ASSET_SHA256 =
  "997f20114ad3db227a854e1e5a886234f76405b155f4af70605d4b7ca4a436a1";
export const CUA_DRIVER_ASSET_BYTES = 35_894_668;
export const CUA_DRIVER_ASSET_URL =
  "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-windows-x86_64.zip";
export const CUA_DRIVER_SHA256SUMS_URL =
  "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/SHA256SUMS";
/** OD-4: the driver child always starts in `standard`; `unrestricted` is never
 *  settable from Loam automation (§2.6, D7). */
export const CUA_DRIVER_PERMISSION_MODE = "standard";

export const CUA_DRIVER_TOOL_ALLOWLIST = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_desktop_state",
  "get_screen_size",
  "click",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
  "invoke_menu",
  "verify_state",
  "start_session",
  "end_session",
] as const;

export type CuaDriverAllowedTool = (typeof CUA_DRIVER_TOOL_ALLOWLIST)[number];

/** REA-style side-effect flags (spec §7.4 — verbatim rows). `mutatesTarget` means the
 *  tool drives GUI state of the target window; host input tools are always-ask. */
export interface CuaToolEffects {
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

const READ_ONLY = (idempotent: boolean): CuaToolEffects => ({
  mutatesTarget: false, mutatesSession: false, writesFilesystem: false, launchesProcess: false,
  accessesNetwork: false, changesUiState: false, mayDiscardData: false, executesForeignCode: false,
  mutatesDevice: false, idempotent,
});
/** Host input tools: drive the target window's GUI (spec rows with mutatesTarget:true). */
const INPUT = (mayDiscardData: boolean): CuaToolEffects => ({
  ...READ_ONLY(false), mutatesTarget: true, changesUiState: true, mayDiscardData,
});
/** Session lifecycle: driver-side state only. */
const SESSION = (mayDiscardData: boolean): CuaToolEffects => ({
  ...READ_ONLY(true), mutatesSession: true, mayDiscardData,
});

/** Static effects per allowlisted tool — the §7.4 table, verbatim. */
export const CUA_DRIVER_TOOL_EFFECTS: Record<CuaDriverAllowedTool, CuaToolEffects> = {
  list_apps: READ_ONLY(true),
  list_windows: READ_ONLY(true),
  get_window_state: READ_ONLY(false),
  get_desktop_state: READ_ONLY(false),
  get_screen_size: READ_ONLY(true),
  click: INPUT(false),
  type_text: INPUT(false),
  press_key: INPUT(false),
  hotkey: INPUT(true),
  scroll: INPUT(false),
  invoke_menu: INPUT(true),
  verify_state: READ_ONLY(false),
  start_session: SESSION(false),
  end_session: SESSION(true),
};

/** Filtered `tools/list` JSON must stay within this budget (§7.4). */
export const CUA_DRIVER_CATALOGUE_BUDGET_BYTES = 200 * 1024;
/** State tools can walk large UIA trees — they get the extended call timeout (§7.4). */
export const CUA_DRIVER_SLOW_TOOLS: ReadonlySet<string> = new Set(["get_window_state", "verify_state"]);
export const CUA_DRIVER_SLOW_TIMEOUT_MS = 120_000;
export const CUA_DRIVER_DEFAULT_TIMEOUT_MS = 30_000;

/** Full 29-tool contract (§2.2) — everything NOT in the allowlist is rejected,
 *  including these explicitly (OD-5 / §7.3 out-list). */
export const CUA_DRIVER_CONTRACT_TOOLS: readonly string[] = [
  "click", "clipboard_read", "clipboard_write", "drag", "end_session", "escalate_session",
  "get_agent_cursor_state", "get_cursor_position", "get_desktop_state", "get_screen_size",
  "get_session", "get_session_state", "get_window_state", "hotkey", "invoke_menu",
  "list_apps", "list_sessions", "list_windows", "move_cursor", "parse_visual_regions",
  "press_key", "scroll", "set_agent_cursor_enabled", "set_agent_cursor_motion",
  "set_agent_cursor_theme", "set_window_frame", "start_session", "type_text", "verify_state",
];

export function isCuaDriverAllowedTool(name: string): name is CuaDriverAllowedTool {
  return (CUA_DRIVER_TOOL_ALLOWLIST as readonly string[]).includes(name);
}

export function filterCuaDriverTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((t) => isCuaDriverAllowedTool(t.name));
}

export function assertCuaCatalogueBudget(filteredToolsJson: string): void {
  const n = Buffer.byteLength(filteredToolsJson, "utf8");
  if (n > CUA_DRIVER_CATALOGUE_BUDGET_BYTES) {
    throw new Error(`cua-driver allowlist catalogue is ${n} bytes; budget is ${CUA_DRIVER_CATALOGUE_BUDGET_BYTES}`);
  }
}

/** Map effects onto Loam's approval tiers (§7.4 tierFromEffects; appendix B5).
 *  Host input tools are `destructive` — Loam's destructive tier never auto-approves,
 *  which is exactly the §6.2 "input tools always ask" rule. */
export function tierFromCuaEffects(v: CuaToolEffects): "read" | "write-workspace" | "exec" | "network-external" | "destructive" {
  if (v.mayDiscardData || v.executesForeignCode || v.mutatesDevice || v.mutatesTarget) return "destructive";
  if (v.accessesNetwork) return "network-external";
  if (v.launchesProcess) return "exec";
  if (v.writesFilesystem) return "write-workspace";
  return "read";
}

export function cuaDriverEffects(name: string): CuaToolEffects | undefined {
  return isCuaDriverAllowedTool(name) ? CUA_DRIVER_TOOL_EFFECTS[name] : undefined;
}

export function cuaDriverTier(name: string): "read" | "write-workspace" | "exec" | "network-external" | "destructive" | undefined {
  const effects = cuaDriverEffects(name);
  return effects ? tierFromCuaEffects(effects) : undefined;
}

export function cuaDriverTimeoutMs(name: string): number {
  return CUA_DRIVER_SLOW_TOOLS.has(name) ? CUA_DRIVER_SLOW_TIMEOUT_MS : CUA_DRIVER_DEFAULT_TIMEOUT_MS;
}
