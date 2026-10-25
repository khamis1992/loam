/** check:cua-allowlist — smoke gate for the Cua Driver allowlist module
 *  (CUA_INTO_LOAM_INTEGRATION §7.3–§7.4; appendix B). Offline — no driver needed.
 *  Proves: 14 contract-backed names, complete effects coverage, the 7/7 tier split,
 *  catalogue budget enforcement, and the pinned release constants (U1 resolved). */
import assert from "node:assert/strict";
import {
  CUA_DRIVER_TOOL_ALLOWLIST,
  CUA_DRIVER_TOOL_EFFECTS,
  CUA_DRIVER_CATALOGUE_BUDGET_BYTES,
  CUA_DRIVER_ASSET,
  CUA_DRIVER_ASSET_BYTES,
  CUA_DRIVER_ASSET_SHA256,
  CUA_DRIVER_MCP_SERVER,
  CUA_DRIVER_PERMISSION_MODE,
  CUA_DRIVER_VERSION_PIN,
  assertCuaCatalogueBudget,
  cuaDriverTier,
  filterCuaDriverTools,
  isCuaDriverAllowedTool,
} from "../tools/cuaDriverAllowlist.js";

// 1. Exactly the 14 spec §7.3 names; high-privacy and non-contract tools stay out.
assert.equal(CUA_DRIVER_MCP_SERVER, "cua-driver");
assert.equal(CUA_DRIVER_TOOL_ALLOWLIST.length, 14);
assert.equal(new Set(CUA_DRIVER_TOOL_ALLOWLIST).size, 14);
for (const banned of ["clipboard_read", "clipboard_write", "parse_visual_regions", "escalate_session", "launch_app"]) {
  assert.equal(isCuaDriverAllowedTool(banned), false);
}

// 2. A full 29-tool contract catalogue (plus non-contract extras) collapses to exactly the allowlist.
const advertised = [
  ...CUA_DRIVER_TOOL_ALLOWLIST.map((name) => ({ name, inputSchema: { type: "object" as const } })),
  ...["clipboard_read", "clipboard_write", "drag", "move_cursor", "parse_visual_regions", "set_window_frame",
    "escalate_session", "set_agent_cursor_theme", "set_agent_cursor_motion", "get_session_state",
    "list_sessions", "get_agent_cursor_state", "get_cursor_position", "launch_app", "run_script"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
];
const filtered = filterCuaDriverTools(advertised);
assert.equal(filtered.length, 14);

// 3. Effects coverage + tier split (appendix B5): reads auto, host input always asks.
for (const name of CUA_DRIVER_TOOL_ALLOWLIST) {
  assert.ok(CUA_DRIVER_TOOL_EFFECTS[name], `missing effects row: ${name}`);
  assert.equal(typeof cuaDriverTier(name), "string", `missing tier: ${name}`);
}
const tiers = CUA_DRIVER_TOOL_ALLOWLIST.map((n) => cuaDriverTier(n));
assert.equal(tiers.filter((t) => t === "read").length, 7);
assert.equal(tiers.filter((t) => t === "destructive").length, 7);
assert.equal(cuaDriverTier("click"), "destructive");
assert.equal(cuaDriverTier("verify_state"), "read");

// 4. Catalogue budget: compact filtered catalogue fits; oversized payload rejected.
const compact = JSON.stringify(filtered);
assert.ok(Buffer.byteLength(compact, "utf8") <= CUA_DRIVER_CATALOGUE_BUDGET_BYTES);
assert.doesNotThrow(() => assertCuaCatalogueBudget(compact));
assert.throws(() => assertCuaCatalogueBudget("x".repeat(CUA_DRIVER_CATALOGUE_BUDGET_BYTES + 1)), /budget/);

// 5. Supply-chain pin (OD-2/§6.7, appendix B8): exact release + fixed asset + sha256.
assert.equal(CUA_DRIVER_VERSION_PIN, "0.38.0");
assert.equal(CUA_DRIVER_ASSET, `cua-driver-rs-${CUA_DRIVER_VERSION_PIN}-windows-x86_64.zip`);
assert.equal(typeof CUA_DRIVER_ASSET_BYTES, "number");
assert.match(CUA_DRIVER_ASSET_SHA256, /^[a-f0-9]{64}$/);
assert.equal(CUA_DRIVER_PERMISSION_MODE, "standard");

console.log(`PASS: check:cua-allowlist — 14 pinned contract tools (cua-driver ${CUA_DRIVER_VERSION_PIN}), 7 read / 7 always-ask tiers, effects coverage complete, catalogue budget ${CUA_DRIVER_CATALOGUE_BUDGET_BYTES}B, asset sha256 pinned`);
