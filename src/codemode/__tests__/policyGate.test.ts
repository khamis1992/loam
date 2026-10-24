/**
 * Codemode policy gate tests (J9).
 *
 * A script can only reach the outside world through `tools.<name>(args)`, so
 * every one of those calls must go through the SAME policy path as a normal
 * tool call: the risk-tier matrix, saved approval rules, the per-task auto-approve
 * toggle, and the plan-mode read-only restriction. These tests drive the real
 * gate (src/codemode/policyGate.ts) with the real approval store and rule store:
 * no network, no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { CodemodeGate, CodemodeGateInput } from "../policyGate.js";

let tmpDir = "";
let closeDb: (() => void) | undefined;
let createCodemodeGate: (input: CodemodeGateInput) => CodemodeGate;
let codemodeTier: (toolName: string, args: Record<string, unknown>, workspaceRoot: string) => string;
let rules: typeof import("../../server/approvalRules.js");
let approvals: typeof import("../../server/approvals.js");
let permissionModes: typeof import("../../policy/permissionModes.js");

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "loam-codemode-ws-"));

async function waitForPending(taskId: string) {
  for (let i = 0; i < 200; i++) {
    const found = approvals.listApprovals(true).find((r) => r.taskId === taskId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

function makeGate(taskId: string, extra: Partial<CodemodeGateInput> = {}): CodemodeGate {
  return createCodemodeGate({
    taskId,
    agentId: null,
    workspaceRoot: WS,
    sandboxMode: "workspace-write",
    ...extra,
  });
}

describe("codemode policy gate", () => {
  before(async () => {
    process.env.MANUS_LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loam-codemode-gate-"));
    const sqlite = await import("../../server/sqliteStore.js");
    closeDb = sqlite.closeDb;
    const gateMod = await import("../policyGate.js");
    ({ createCodemodeGate, codemodeTier } = gateMod);
    rules = await import("../../server/approvalRules.js");
    approvals = await import("../../server/approvals.js");
    permissionModes = await import("../../policy/permissionModes.js");
  });

  after(() => {
    closeDb?.();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(WS, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("classifies a script tool call with the same risk tier as a normal call", () => {
    assert.equal(codemodeTier("file_read", { path: "a.ts" }, WS), "read");
    assert.equal(codemodeTier("file_write", { path: "a.ts" }, WS), "write-workspace");
    assert.equal(codemodeTier("file_write", { path: "C:/Windows/system32/x.dll" }, WS), "write-outside");
    assert.equal(codemodeTier("shell_run", { command: "echo hi" }, WS), "exec");
    assert.equal(codemodeTier("shell_run", { command: "rm -rf /" }, WS), "destructive");
    assert.equal(codemodeTier("web_fetch", { url: "https://example.com" }, WS), "network-external");
  });

  it("allows a read call without prompting", async () => {
    const gate = makeGate("task_cm_read");
    assert.equal(await gate.authorize("file_read", { path: "a.ts" }), undefined);
  });

  it("prompts for an exec call that is not auto-approved, then allows it on approve", async () => {
    const taskId = "task_cm_ask";
    const gate = makeGate(taskId);
    const pending: string[] = [];
    const withEmit = createCodemodeGate({
      taskId,
      agentId: null,
      workspaceRoot: WS,
      sandboxMode: "workspace-write",
      emit: (event) => {
        if (event.type === "approval_required") pending.push(event.approvalId);
      },
    });

    const decision = withEmit.authorize("shell_run", { command: "echo hi" });
    const record = await waitForPending(taskId);
    assert.ok(record, "an exec call must raise an approval card");
    assert.equal(pending.length, 1, "the UI must be told about the pending approval");
    assert.equal(record!.tool, "shell_run");

    approvals.decideApproval(record!.id, "approve");
    assert.equal(await decision, undefined, "an approved call must be allowed");
  });

  it("keeps a policy-denied tool denied", async () => {
    const taskId = "task_cm_deny";
    const gate = makeGate(taskId, { sandboxMode: "read-only" });
    const refusal = await gate.authorize("shell_run", { command: "echo hi" });
    assert.ok(refusal, "a shell call is denied outright in read-only mode");
    assert.match(refusal!, /denied in read-only mode/);
    // Nothing was ever asked of the user: a deny is not an approval card.
    assert.equal(approvals.listApprovals(true).length, 0);
  });

  it("stays denied when the user denies the approval card", async () => {
    const taskId = "task_cm_user_deny";
    const gate = makeGate(taskId);
    const decision = gate.authorize("web_fetch", { url: "https://example.com" });
    const record = await waitForPending(taskId);
    assert.ok(record);
    approvals.decideApproval(record!.id, "deny");
    const refusal = await decision;
    assert.ok(refusal, "a denied call must be refused");
    assert.match(refusal!, /denied/);
  });

  it("refuses a mutating call in plan mode without prompting", async () => {
    const taskId = "task_cm_plan";
    rules.setTaskPermissionMode(taskId, "plan");
    const gate = makeGate(taskId);
    const refusal = await gate.authorize("file_write", { path: "a.ts", content: "x" });
    assert.ok(refusal, "plan mode is read-only");
    assert.equal(approvals.listApprovals(true).length, 0, "a plan-mode refusal never becomes an approval card");
    // A read call still works in plan mode.
    assert.equal(await gate.authorize("file_read", { path: "a.ts" }), undefined);
  });

  it("replays a saved decision instead of prompting twice", async () => {
    const taskId = "task_cm_replay";
    const gate = makeGate(taskId);
    const first = gate.authorize("web_fetch", { url: "https://example.com" });
    const record = await waitForPending(taskId);
    approvals.decideApproval(record!.id, "approve");
    assert.equal(await first, undefined);

    const pending: string[] = [];
    const second = makeGate(taskId).authorize("web_fetch", { url: "https://example.com" });
    assert.equal(await second, undefined, "the same call must replay the saved allow");
    assert.equal(pending.length, 0);
  });

  it("honours a saved allow rule for the exact tool and arguments", async () => {
    const taskId = "task_cm_rule";
    rules.createApprovalRule({ agentId: null, tool: "web_fetch", pattern: "example.com", decision: "allow" });
    const gate = makeGate(taskId);
    assert.equal(await gate.authorize("web_fetch", { url: "https://example.com/page" }), undefined, "a matching rule allows without prompting");
    // A different argument does not match the saved pattern.
    const decision = gate.authorize("web_fetch", { url: "https://other.test/" });
    const record = await waitForPending(taskId);
    assert.ok(record, "a non-matching call still prompts");
    approvals.decideApproval(record!.id, "deny");
    assert.ok(await decision);
  });

  it("never auto-approves a destructive or secret call", async () => {
    const taskId = "task_cm_destructive";
    rules.setTaskApprovalAuto(taskId, true);
    const gate = makeGate(taskId);
    const decision = gate.authorize("shell_run", { command: "rm -rf /" });
    const record = await waitForPending(taskId);
    assert.ok(record, "even auto-approve must prompt for a destructive call");
    approvals.decideApproval(record!.id, "deny");
    assert.ok(await decision, "and the denial must be enforced");
  });

  it("allows an exec call under the task auto-approve toggle", async () => {
    const taskId = "task_cm_auto";
    rules.setTaskApprovalAuto(taskId, true);
    const gate = makeGate(taskId);
    assert.equal(await gate.authorize("shell_run", { command: "echo hi" }), undefined, "auto-approve allows a plain exec call");
  });

  it("maps the plan permission mode to the read-only sandbox", () => {
    assert.equal(permissionModes.permissionModeSandboxMode("plan"), "read-only");
    assert.equal(permissionModes.permissionModeSandboxMode("approve_for_me"), "workspace-write");
    assert.equal(permissionModes.permissionModeSandboxMode("full_access"), "danger-full-access");
  });
});
