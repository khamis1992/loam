/**
 * A7 verification runner.
 *
 * Run with: npx tsx docs/handoff/a07-tests.ts
 *
 * Covers:
 * - src/policy/permissionModes.ts
 * - src/protocol/approvals.ts
 * - String coverage against BUILD_SPEC §5.8 / §5.9
 * - Deny-produces-no-side-effect guarantee
 */
import assert from "node:assert/strict";
import {
  isLocalPermissionMode,
  DEFAULT_PERMISSION_MODE,
  reviewLocalAction,
  normalizePath,
  isInsideGrantedFolder,
  effortBudgets,
  mapAgentModeToLoam,
  buildRunExtData,
  MODEL_MENU_ITEMS,
  PERMISSION_MODE_INFO,
  EFFORT_OPTIONS,
} from "../../src/policy/permissionModes.ts";
import {
  requestLocalExecutionApproval,
  resolveLocalExecutionApproval,
  createOptimisticLocalExecutionResolution,
  isDeniedOrExpired,
  createFolderAccessRequestEvent,
  changeLocalPermissionMode,
  createWorkspaceDirectoryAccessRequest,
  submitWorkspaceDirectoryAccess,
  waitForWorkspaceDirectoryAccess,
  getLocalExecutionApprovalRecord,
} from "../../src/protocol/approvals.ts";
import fs from "node:fs";
import path from "node:path";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ----------------------------------------------------------------------------
// Permission modes
// ----------------------------------------------------------------------------

test("default permission mode is approve_for_me", () => {
  assert.equal(DEFAULT_PERMISSION_MODE, "approve_for_me");
});

test("isLocalPermissionMode accepts only known modes", () => {
  assert.ok(isLocalPermissionMode("ask_for_approval"));
  assert.ok(isLocalPermissionMode("approve_for_me"));
  assert.ok(isLocalPermissionMode("full_access"));
  assert.ok(!isLocalPermissionMode("none"));
});

test("full_access never requires approval", () => {
  const review = reviewLocalAction({
    mode: "full_access",
    action: "write",
    targetPath: "/etc/passwd",
    requiresNetwork: true,
    flaggedReason: "dangerous",
  });
  assert.equal(review.needsApproval, false);
  assert.equal(review.reviewer, "auto");
});

test("in-workspace reads/writes are safe", () => {
  const grants = [{ path: "/workspace", mode: "always", grantedAt: Date.now() }];
  for (const mode of ["ask_for_approval", "approve_for_me"] as const) {
    const read = reviewLocalAction({ mode, action: "read", targetPath: "/workspace/file.txt", grants });
    assert.equal(read.needsApproval, false, `mode=${mode} read should be safe`);
    const write = reviewLocalAction({ mode, action: "write", targetPath: "/workspace/out.log", grants });
    assert.equal(write.needsApproval, false, `mode=${mode} write should be safe`);
  }
});

test("write outside granted folders requires approval", () => {
  const review = reviewLocalAction({
    mode: "approve_for_me",
    action: "write",
    targetPath: "/tmp/outside.txt",
    grants: [{ path: "/workspace", mode: "always", grantedAt: Date.now() }],
  });
  assert.equal(review.needsApproval, true);
  assert.equal(review.reviewer, "user");
});

test("terminal outside workspace requires approval", () => {
  const review = reviewLocalAction({
    mode: "approve_for_me",
    action: "terminal",
    targetPath: "/tmp",
    grants: [{ path: "/workspace", mode: "always", grantedAt: Date.now() }],
  });
  assert.equal(review.needsApproval, true);
});

test("flagged actions always require user approval", () => {
  const review = reviewLocalAction({
    mode: "approve_for_me",
    action: "read",
    targetPath: "/workspace/file.txt",
    grants: [{ path: "/workspace", mode: "always", grantedAt: Date.now() }],
    flaggedReason: "deny-list match",
  });
  assert.equal(review.needsApproval, true);
  assert.equal(review.reviewer, "user");
});

// ----------------------------------------------------------------------------
// Path containment
// ----------------------------------------------------------------------------

test("normalizePath resolves relative segments", () => {
  const base = process.cwd();
  assert.equal(normalizePath("./src/../src/policy").toLowerCase(), `${base.toLowerCase()}\\src\\policy`);
});

test("isInsideGrantedFolder matches exact and child paths", () => {
  const grants = [{ path: "/workspace", mode: "always", grantedAt: Date.now() }];
  assert.ok(isInsideGrantedFolder("/workspace", grants));
  assert.ok(isInsideGrantedFolder("/workspace/sub/file.txt", grants));
  assert.ok(!isInsideGrantedFolder("/workspace2", grants));
});

// ----------------------------------------------------------------------------
// Effort and model mapping
// ----------------------------------------------------------------------------

test("effort budgets increase with level", () => {
  const medium = effortBudgets("medium");
  const high = effortBudgets("high");
  const extra = effortBudgets("extra");
  const ultra = effortBudgets("ultra");
  assert.ok(medium.stepBudget < high.stepBudget);
  assert.ok(high.stepBudget <= extra.stepBudget);
  assert.ok(extra.stepBudget <= ultra.stepBudget);
});

test("agent mode mapping produces a concrete Loam profile", () => {
  assert.equal(mapAgentModeToLoam("max").loamMode, "build");
  assert.equal(mapAgentModeToLoam("max").effort, "ultra");
  assert.equal(mapAgentModeToLoam("standard").loamMode, "build");
  assert.equal(mapAgentModeToLoam("lite").loamMode, "ask");
  assert.equal(mapAgentModeToLoam("flex").model, undefined);
  assert.equal(mapAgentModeToLoam("flex", { flexModelId: "gpt-4" }).model, "gpt-4");
});

test("run extData carries mode, effort and permission mode", () => {
  const ext = buildRunExtData("max", "ultra", "ask_for_approval");
  assert.equal(ext.mode, "build");
  assert.equal(ext.effort, "ultra");
  assert.equal(ext.localPermissionMode, "ask_for_approval");
  assert.equal(ext.executionTarget?.kind, "desktop");
});

// ----------------------------------------------------------------------------
// Protocol: local execution approval
// ----------------------------------------------------------------------------

test("safe in-workspace file read is auto-approved", () => {
  const result = requestLocalExecutionApproval({
    permissionMode: "approve_for_me",
    actionType: "file",
    detail: { kind: "file", operation: "read", path: "/workspace/README.md" },
    grants: [{ path: "/workspace", mode: "always", grantedAt: Date.now() }],
  });
  assert.equal(result.autoResult, "approve");
  assert.equal(result.event, undefined);
});

test("terminal outside workspace creates a user approval request", () => {
  const result = requestLocalExecutionApproval({
    permissionMode: "ask_for_approval",
    actionType: "terminal",
    detail: { kind: "terminal", command: "echo hi", cwd: "/tmp" },
    grants: [{ path: "/workspace", mode: "always", grantedAt: Date.now() }],
  });
  assert.ok(result.event, "expected an approval request event");
  assert.equal(result.event!.reviewer, "user");
  assert.equal(result.event!.actionType, "terminal");
  assert.ok(result.event!.requestId.startsWith("appr_"), "requestId bridges to Loam approval id");
});

test("deny resolves the approval and produces no side-effect record", () => {
  const { event: requested } = requestLocalExecutionApproval({
    permissionMode: "ask_for_approval",
    actionType: "file",
    detail: { kind: "file", operation: "write", path: "/tmp/outside.txt" },
    grants: [{ path: "/workspace", mode: "always", grantedAt: Date.now() }],
  });
  assert.ok(requested);
  const { event: resolved, record } = resolveLocalExecutionApproval({
    type: "resolve_local_execution_approval",
    sessionId: "s_1",
    requestId: requested!.requestId,
    resolution: "deny",
  });
  assert.equal(resolved.result, "deny");
  assert.equal(record?.status, "denied");
  assert.ok(isDeniedOrExpired(requested!.requestId));
});

test("optimistic resolution carries the request id and result", () => {
  const res = createOptimisticLocalExecutionResolution("req_123", "approve");
  assert.equal(res.requestId, "req_123");
  assert.equal(res.result, "approve");
  assert.equal(res.reviewer, "user");
});

// ----------------------------------------------------------------------------
// Protocol: folder access chat card
// ----------------------------------------------------------------------------

test("folder access request event matches expected shape", () => {
  const ev = createFolderAccessRequestEvent("req_x", "/workspace", "write");
  assert.equal(ev.type, "folderAccessRequest");
  assert.equal(ev.requestId, "req_x");
  assert.equal(ev.path, "/workspace");
  assert.equal(ev.access, "write");
});

// ----------------------------------------------------------------------------
// Protocol: workspace directory access
// ----------------------------------------------------------------------------

await (async () => {
  const request = createWorkspaceDirectoryAccessRequest({
    actionId: "dir_1",
    deviceId: "desktop-1",
    requestedPath: "/Users/x/Documents",
  });
  const waitPromise = waitForWorkspaceDirectoryAccess(request);

  await test("workspace directory access deny is a cancellation with no side effect", async () => {
    const result = submitWorkspaceDirectoryAccess({
      type: "submit_workspace_directory_access",
      sessionId: "s_1",
      requestActionId: request.actionId,
      accept: false,
    });
    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    const awaited = await waitPromise;
    assert.equal(awaited.cancelled, true);
  });
})();

await (async () => {
  const request = createWorkspaceDirectoryAccessRequest({
    actionId: "dir_2",
    deviceId: "desktop-1",
    requestedPath: "/Users/x/Documents",
  });

  const waitPromise = waitForWorkspaceDirectoryAccess(request);

  await test("workspace directory access accept resolves the pending request", async () => {
    const acceptResult = submitWorkspaceDirectoryAccess({
      type: "submit_workspace_directory_access",
      sessionId: "s_1",
      requestActionId: request.actionId,
      accept: true,
      directory: { deviceId: "desktop-1", name: "Documents", path: "/Users/x/Documents" },
    });
    assert.equal(acceptResult.success, true);
    const awaited = await waitPromise;
    assert.equal(awaited.success, true);
    assert.equal(awaited.requestActionId, request.actionId);
  });
})();

// ----------------------------------------------------------------------------
// Permission mode change
// ----------------------------------------------------------------------------

test("changeLocalPermissionMode emits a result event", () => {
  const result = changeLocalPermissionMode(
    { type: "change_local_permission_mode", sessionId: "s_1", mode: "ask_for_approval" },
    "approve_for_me",
    "u_1",
    "evt_1",
  );
  assert.equal(result.type, "localPermissionModeChangeResult");
  assert.equal(result.mode, "ask_for_approval");
  assert.equal(result.previousMode, "approve_for_me");
  assert.equal(result.success, true);
  assert.equal(result.sourceUserId, "u_1");
});

// ----------------------------------------------------------------------------
// String coverage against BUILD_SPEC
// ----------------------------------------------------------------------------

test("BUILD_SPEC user-visible strings are present in A7 source", () => {
  const dirs = [
    "../../packages/web/src/components/approval",
    "../../packages/web/src/components/model-menu",
    "../../src/policy",
    "../../src/protocol",
  ];
  const sources: string[] = [];
  for (const dir of dirs) {
    const abs = path.resolve(import.meta.dirname ?? ".", dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        sources.push(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf-8"));
      }
    }
  }
  const combined = sources.join("\n");

  const requiredStrings = [
    // §5.8 / §6.7 folder access
    "Folder access request",
    "Allow once",
    "Always allow in {product}",
    "Deny",
    // §7.2.2 execution approval
    "Run a local command",
    "Modify a local file",
    "Bash",
    "write access",
    "Flagged by the local safety rule: {reason}",
    "Allowing lets this command keep running; {product} can view it, interact with it, and stop it while it runs.",
    // §5.9 S17 permission menu
    "Ask for approval",
    "Approve for me",
    "Full access",
    "Always asks for approval before local actions.",
    "Reviews and auto-approves safe local actions.",
    "Runs local actions without approval.",
    // §5.9 S15 model menu
    "{product} 2.0 Max",
    "{product} 2.0",
    "{product} 2.0 Lite",
    "{product} Flex",
    "High-performance agent designed for complex tasks.",
    "Versatile agent capable of most tasks.",
    "A lightweight agent for everyday tasks.",
    "Bring your own model API key to power {product}.",
    // §5.9 S16 effort panel
    "Medium",
    "High",
    "Extra",
    "Ultra",
    "Effort",
  ];

  for (const s of requiredStrings) {
    assert.ok(combined.includes(s), `missing BUILD_SPEC string: ${s}`);
  }
});

test("model menu items match BUILD_SPEC §5.9 S15", () => {
  const titles = MODEL_MENU_ITEMS.map((i) => i.title);
  assert.ok(titles.includes("{product} 2.0 Max"));
  assert.ok(titles.includes("{product} 2.0"));
  assert.ok(titles.includes("{product} 2.0 Lite"));
  assert.ok(titles.includes("{product} Flex"));
  const flex = MODEL_MENU_ITEMS.find((i) => i.mode === "flex")!;
  assert.ok(flex.description.includes("API key"));
});

test("effort options match BUILD_SPEC §5.9 S16 labels", () => {
  const labels = EFFORT_OPTIONS.map((o) => o.label);
  assert.deepEqual(labels, ["Medium", "High", "Extra", "Ultra"]);
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------

if (process.exitCode) {
  console.error("\nA7 tests failed.");
} else {
  console.log("\nA7 tests passed.");
}
