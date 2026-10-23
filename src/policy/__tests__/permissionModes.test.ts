/**
 * C13 plan-mode tests.
 *
 * Plan mode is the read-only planning phase: reads and read-only web research
 * pass, every mutating tier is refused, and `plan_exit` is the only escape
 * hatch. These tests pin the gate matrix that enforces it and the review helper
 * that surfaces it to the UI.
 */
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import {
  DEFAULT_PERMISSION_MODE,
  LOCAL_PERMISSION_MODES,
  PERMISSION_MODE_INFO,
  gateToolCallForPermissionMode,
  isPlanMode,
  isReadOnlyPermissionMode,
  permissionModeSandboxMode,
  reviewLocalAction,
  type LocalActionKind,
} from "../permissionModes.js";

const WS = path.resolve(process.cwd(), "task-workspace");

test("plan is a registered local permission mode", () => {
  assert.ok(LOCAL_PERMISSION_MODES.includes("plan"));
  assert.equal(isPlanMode("plan"), true);
  assert.equal(isPlanMode(DEFAULT_PERMISSION_MODE), false);
  assert.equal(isReadOnlyPermissionMode("plan"), true);
  assert.equal(isReadOnlyPermissionMode("approve_for_me"), false);
  assert.equal(PERMISSION_MODE_INFO.plan.mode, "plan");
  assert.equal(PERMISSION_MODE_INFO.plan.isDangerous, false);
});

test("plan mode maps onto the read-only sandbox vocabulary", () => {
  assert.equal(permissionModeSandboxMode("plan"), "read-only");
  assert.equal(permissionModeSandboxMode("ask_for_approval"), "workspace-write");
  assert.equal(permissionModeSandboxMode("approve_for_me"), "workspace-write");
  assert.equal(permissionModeSandboxMode("full_access"), "danger-full-access");
});

test("plan mode allows reads and read-only research", () => {
  assert.equal(gateToolCallForPermissionMode("plan", "file_read", { path: "src/a.ts" }, WS).allowed, true);
  assert.equal(gateToolCallForPermissionMode("plan", "file_list", { path: "src" }, WS).allowed, true);
  assert.equal(gateToolCallForPermissionMode("plan", "web_fetch", { url: "https://example.com" }, WS).allowed, true);
  assert.equal(gateToolCallForPermissionMode("plan", "web_search", { query: "x" }, WS).allowed, true);
});

test("plan mode keeps control/communication tools usable", () => {
  for (const tool of ["think", "plan", "plan_exit", "finish", "message", "phase_set"]) {
    assert.equal(gateToolCallForPermissionMode("plan", tool, {}, WS).allowed, true, tool);
  }
});

test("plan mode blocks every mutating tier", () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; tier: string }> = [
    { tool: "file_write", args: { path: "src/a.ts" }, tier: "write-workspace" },
    { tool: "file_edit", args: { path: "src/a.ts", find: "a", replace: "b" }, tier: "write-workspace" },
    { tool: "file_write", args: { path: "../outside.ts" }, tier: "write-outside" },
    { tool: "shell_run", args: { command: "ls -la" }, tier: "exec" },
    { tool: "shell_run", args: { command: "rm -rf /tmp/x" }, tier: "destructive" },
    { tool: "secrets_read", args: {}, tier: "secret" },
  ];
  for (const c of cases) {
    const decision = gateToolCallForPermissionMode("plan", c.tool, c.args, WS);
    assert.equal(decision.allowed, false, `${c.tool} should be blocked`);
    assert.match(decision.reason ?? "", new RegExp(c.tier), `${c.tool} reason should name ${c.tier}`);
  }
});

test("acceptEdits (approve_for_me) allows workspace edits after plan_exit approval", () => {
  assert.equal(gateToolCallForPermissionMode("approve_for_me", "file_write", { path: "src/a.ts" }, WS).allowed, true);
  assert.equal(gateToolCallForPermissionMode("approve_for_me", "file_read", { path: "src/a.ts" }, WS).allowed, true);
  // Commands still need approval in workspace-write, so the gate refuses them.
  assert.equal(gateToolCallForPermissionMode("approve_for_me", "shell_run", { command: "ls" }, WS).allowed, false);
});

test("reviewLocalAction holds non-read actions for the user in plan mode", () => {
  const read = reviewLocalAction({ mode: "plan", action: "read" });
  assert.equal(read.needsApproval, false);
  assert.equal(read.reviewer, "auto");

  for (const action of ["write", "terminal", "workspace", "network"] as LocalActionKind[]) {
    const review = reviewLocalAction({ mode: "plan", action });
    assert.equal(review.needsApproval, true, action);
    assert.equal(review.reviewer, "user", action);
    assert.match(review.reason ?? "", /plan_exit/, action);
  }
});
