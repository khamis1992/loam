import assert from "node:assert/strict";
import test from "node:test";
import {
  CUA_DRIVER_CONTRACT_TOOLS,
  CUA_DRIVER_TOOL_ALLOWLIST,
  CUA_DRIVER_TOOL_EFFECTS,
  CUA_DRIVER_ASSET_SHA256,
  CUA_DRIVER_PERMISSION_MODE,
  CUA_DRIVER_SLOW_TOOLS,
  filterCuaDriverTools,
  isCuaDriverAllowedTool,
  cuaDriverEffects,
  cuaDriverTier,
  cuaDriverTimeoutMs,
  tierFromCuaEffects,
  type CuaToolEffects,
} from "../cuaDriverAllowlist.js";
import { isCuaElementToken } from "../cuaDriverTypes.js";

test("allowlist is exactly the 14 contract-backed tools of spec 7.3", () => {
  assert.equal(CUA_DRIVER_TOOL_ALLOWLIST.length, 14);
  // High-privacy / non-contract surfaces stay out (OD-5, §7.3 out-list).
  for (const banned of ["clipboard_read", "clipboard_write", "drag", "move_cursor", "parse_visual_regions", "set_window_frame", "escalate_session", "set_agent_cursor_theme", "launch_app", "run_script", "run_steps"]) {
    assert.equal(isCuaDriverAllowedTool(banned), false, banned);
  }
});

test("allowlist is a subset of the observed 29-tool contract", () => {
  const contract = new Set(CUA_DRIVER_CONTRACT_TOOLS);
  assert.equal(contract.size, 29);
  for (const name of CUA_DRIVER_TOOL_ALLOWLIST) assert.ok(contract.has(name), `not in contract: ${name}`);
});

test("every allowlisted tool has an effects row and a derived tier (7 read / 7 destructive, appendix B5)", () => {
  assert.equal(Object.keys(CUA_DRIVER_TOOL_EFFECTS).length, 14);
  const tiers = CUA_DRIVER_TOOL_ALLOWLIST.map((n) => cuaDriverTier(n));
  assert.equal(tiers.filter((t) => t === "read").length, 7);
  assert.equal(tiers.filter((t) => t === "destructive").length, 7);
  // The six host input tools always ask; end_session escalates via mayDiscardData.
  for (const input of ["click", "type_text", "press_key", "hotkey", "scroll", "invoke_menu", "end_session"]) {
    assert.equal(cuaDriverTier(input), "destructive", input);
  }
  for (const ro of ["list_apps", "list_windows", "get_window_state", "get_desktop_state", "get_screen_size", "verify_state", "start_session"]) {
    assert.equal(cuaDriverTier(ro), "read", ro);
  }
});

test("no allowlisted tool touches network/process/filesystem/device/foreign code", () => {
  for (const name of CUA_DRIVER_TOOL_ALLOWLIST) {
    const v = CUA_DRIVER_TOOL_EFFECTS[name];
    assert.ok(v, name);
    assert.equal(v.accessesNetwork || v.launchesProcess || v.writesFilesystem || v.mutatesDevice || v.executesForeignCode, false, name);
  }
});

test("tierFromCuaEffects escalation order", () => {
  const base: CuaToolEffects = { mutatesTarget: false, mutatesSession: false, writesFilesystem: false, launchesProcess: false, accessesNetwork: false, changesUiState: false, mayDiscardData: false, executesForeignCode: false, mutatesDevice: false, idempotent: true };
  assert.equal(tierFromCuaEffects(base), "read");
  assert.equal(tierFromCuaEffects({ ...base, writesFilesystem: true }), "write-workspace");
  assert.equal(tierFromCuaEffects({ ...base, launchesProcess: true }), "exec");
  assert.equal(tierFromCuaEffects({ ...base, accessesNetwork: true }), "network-external");
  assert.equal(tierFromCuaEffects({ ...base, mutatesTarget: true }), "destructive");
  assert.equal(tierFromCuaEffects({ ...base, mayDiscardData: true }), "destructive");
});

test("filterCuaDriverTools drops everything outside the allowlist", () => {
  const advertised = [
    ...CUA_DRIVER_CONTRACT_TOOLS.map((name) => ({ name })),
    { name: "launch_app" }, { name: "run_script" }, { name: "evil_extra" },
  ];
  const filtered = filterCuaDriverTools(advertised);
  assert.equal(filtered.length, 14);
  assert.deepEqual(new Set(filtered.map((t) => t.name)), new Set<string>(CUA_DRIVER_TOOL_ALLOWLIST));
});

test("state tools get the 120s timeout; everything else the 30s default", () => {
  assert.equal(cuaDriverTimeoutMs("get_window_state"), 120_000);
  assert.equal(cuaDriverTimeoutMs("verify_state"), 120_000);
  assert.equal(cuaDriverTimeoutMs("click"), 30_000);
  assert.equal(cuaDriverTimeoutMs("list_windows"), 30_000);
  assert.ok([...CUA_DRIVER_SLOW_TOOLS].every((t) => isCuaDriverAllowedTool(t)));
});

test("supply-chain pin: exact version, fixed asset, sha256 recorded (appendix B8 / U1)", () => {
  assert.match(CUA_DRIVER_ASSET_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(CUA_DRIVER_PERMISSION_MODE, "standard");
});

test("element token shape ^s[0-9a-f]{8}:[0-9]+$ (stale tokens must fail)", () => {
  assert.equal(isCuaElementToken("s0a1b2c3d:42"), true);
  assert.equal(isCuaElementToken("s0A1B2C3D:42"), false); // uppercase hex rejected
  assert.equal(isCuaElementToken("s0a1b2c:42"), false); // 7 hex chars
  assert.equal(isCuaElementToken("click_me"), false);
});
