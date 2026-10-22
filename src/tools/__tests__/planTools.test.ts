/**
 * C13 plan-mode acceptance tests.
 *
 * The acceptance criterion is end-to-end: while a task is in the read-only
 * `plan` mode an edit is refused before it runs, and after `plan_exit` is
 * approved the same edit runs. These tests drive the real gate wrapper, the real
 * `plan_exit` tool and the real approval store (no network, no model calls).
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

type PlanToolsApi = typeof import("../planTools.js");
type ApprovalRulesApi = typeof import("../../server/approvalRules.js");
type ApprovalsApi = typeof import("../../server/approvals.js");
type RegistryApi = typeof import("../registry.js");
type ToolContextApi = import("../registry.js").ToolContext;

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "loam-plan-ws-"));

let plan: PlanToolsApi;
let rules: ApprovalRulesApi;
let approvals: ApprovalsApi;
let registryApi: RegistryApi;

async function waitForPendingPlanApproval(taskId: string) {
  for (let i = 0; i < 100; i++) {
    const found = approvals.listApprovals(true).find((r) => r.taskId === taskId && r.tool === "plan_exit");
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

function makeCtx(taskId: string): ToolContextApi {
  return {
    cfg: {} as ToolContextApi["cfg"],
    workspace: WS,
    emit: () => {},
    taskId,
    signal: new AbortController().signal,
  };
}

describe("plan mode", () => {
  before(async () => {
    process.env.MANUS_LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loam-plan-mode-"));
    await import("../../server/sqliteStore.js");
    plan = await import("../planTools.js");
    rules = await import("../../server/approvalRules.js");
    approvals = await import("../../server/approvals.js");
    registryApi = await import("../registry.js");
  });

  it("parsePlanExitArgs normalizes and validates the plan payload", () => {
    assert.deepEqual(plan.parsePlanExitArgs({ summary: " Add a test ", steps: [" Write it ", ""], files_to_edit: [" a.ts "] }), {
      summary: "Add a test",
      steps: ["Write it"],
      filesToEdit: ["a.ts"],
    });
    assert.match((plan.parsePlanExitArgs({}) as { error: string }).error, /summary/);
    assert.match((plan.parsePlanExitArgs({ summary: "x".repeat(4001) }) as { error: string }).error, /4000/);
  });

  it("formatPlanPreview renders the summary, steps and files", () => {
    const text = plan.formatPlanPreview({ summary: "Do the thing", steps: ["First", "Second"], filesToEdit: ["a.ts", "b.ts"] });
    assert.match(text, /Do the thing/);
    assert.match(text, /1\. First/);
    assert.match(text, /2\. Second/);
    assert.match(text, /- a\.ts/);
    assert.match(text, /- b\.ts/);
  });

  it("blocks an edit in plan mode and allows it after plan_exit approval", async () => {
    const taskId = "task_plan_accept";
    rules.setTaskPermissionMode(taskId, "plan");

    const writes: string[] = [];
    const registry = new registryApi.ToolRegistry();
    registry.register({
      name: "file_write",
      description: "write a file",
      parameters: {},
      run: async () => {
        writes.push("write");
        return { ok: true, content: "written" };
      },
    });
    const gated = registry.forAllowlist(["file_write"]);
    for (const tool of plan.createPlanTools()) gated.register(tool);
    plan.applyPlanModeGate(gated, { taskId, workspaceRoot: WS });
    const ctx = makeCtx(taskId);

    // Plan mode is active: the edit is refused and never reaches the tool.
    const blocked = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
    assert.equal(blocked.ok, false);
    assert.match(blocked.content, /Plan mode is read-only/);
    assert.deepEqual(writes, []);

    // Present the plan; the tool blocks until the user decides.
    const exitPromise = gated.exec("plan_exit", { summary: "Add a test", steps: ["Write the test"], files_to_edit: ["a.ts"] }, ctx);
    const pending = await waitForPendingPlanApproval(taskId);
    assert.ok(pending, "expected a pending plan approval");
    approvals.decideApproval(pending!.id, "approve");

    const approved = await exitPromise;
    assert.equal(approved.ok, true);
    assert.equal(rules.taskPermissionMode(taskId), "approve_for_me");

    // The task switched to acceptEdits: the same edit now runs.
    const allowed = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
    assert.equal(allowed.ok, true);
    assert.deepEqual(writes, ["write"]);
  });

  it("keeps plan mode read-only when the plan is denied", async () => {
    const taskId = "task_plan_deny";
    rules.setTaskPermissionMode(taskId, "plan");

    const writes: string[] = [];
    const registry = new registryApi.ToolRegistry();
    registry.register({
      name: "file_write",
      description: "write a file",
      parameters: {},
      run: async () => {
        writes.push("write");
        return { ok: true, content: "written" };
      },
    });
    const gated = registry.forAllowlist(["file_write"]);
    for (const tool of plan.createPlanTools()) gated.register(tool);
    plan.applyPlanModeGate(gated, { taskId, workspaceRoot: WS });
    const ctx = makeCtx(taskId);

    const exitPromise = gated.exec("plan_exit", { summary: "Add a test" }, ctx);
    const pending = await waitForPendingPlanApproval(taskId);
    assert.ok(pending, "expected a pending plan approval");
    approvals.decideApproval(pending!.id, "deny");

    const denied = await exitPromise;
    assert.equal(denied.ok, false);
    assert.match(denied.content, /still read-only/);
    assert.equal(rules.taskPermissionMode(taskId), "plan");

    const blocked = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
    assert.equal(blocked.ok, false);
    assert.deepEqual(writes, []);
  });

  it("does not gate tools when the task is not in plan mode", async () => {
    const taskId = "task_plan_inactive";
    const registry = new registryApi.ToolRegistry();
    const writes: string[] = [];
    registry.register({
      name: "file_write",
      description: "write a file",
      parameters: {},
      run: async () => {
        writes.push("write");
        return { ok: true, content: "written" };
      },
    });
    const gated = registry.forAllowlist(["file_write"]);
    plan.applyPlanModeGate(gated, { taskId, workspaceRoot: WS });

    const result = await gated.exec("file_write", { path: "a.ts", content: "x" }, makeCtx(taskId));
    assert.equal(result.ok, true);
    assert.deepEqual(writes, ["write"]);
  });
});
