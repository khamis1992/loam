import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { before, describe, it } from "node:test";

type ApprovalRulesApi = typeof import("../approvalRules.js");
let tmpDir = "";
let api!: ApprovalRulesApi;

describe("approvalRules", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-approval-rules-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    await import("../sqliteStore.js");
    api = await import("../approvalRules.js");
  });

  it("sets up tables and lists rules for an agent (agent + global)", () => {
    assert.equal(api.listApprovalRules("agent_a").length, 0);
    const agentRule = api.createApprovalRule({ agentId: "agent_a", tool: "computer_click", decision: "allow" });
    const globalRule = api.createApprovalRule({ tool: "computer_click", decision: "deny" });
    assert.equal(agentRule.agentId, "agent_a");
    assert.equal(globalRule.agentId, null);
    const forA = api.listApprovalRules("agent_a");
    assert.equal(forA.length, 2);
    assert.equal(api.listApprovalRules("agent_b").length, 1);
  });

  it("matches agent-specific rules before global ones (precedence)", () => {
    const a1 = api.createApprovalRule({ agentId: "agent_a", tool: "computer_click", decision: "allow" });
    const g1 = api.createApprovalRule({ tool: "computer_click", decision: "deny" });
    const matched = api.matchApprovalRule({ agentId: "agent_a", tool: "computer_click", args: { todo: "x" } });
    assert.ok(matched);
    assert.equal(matched!.id, a1.id);
    assert.equal(matched!.decision, "allow");
    // The agent-specific rule can deny while the global one allows.
    api.createApprovalRule({ agentId: "agent_a", tool: "computer_type", decision: "deny" });
    const typeA = api.matchApprovalRule({ agentId: "agent_a", tool: "computer_type" });
    assert.equal(typeA!.decision, "deny");
    void g1;
  });

  it("falls back to global rules when the agent has none", () => {
    const matched = api.matchApprovalRule({ agentId: "agent_b", tool: "computer_click", args: {} });
    assert.ok(matched);
    assert.equal(matched!.agentId, null);
    assert.equal(matched!.decision, "deny");
  });

  it("matches args patterns and ignores non-matching ones", () => {
    api.createApprovalRule({ agentId: "agent_p", tool: "pattern_tool", pattern: "confirm", decision: "deny" });
    // No matching pattern yet → request still needs prompting (no rule at all).
    assert.equal(api.matchApprovalRule({ agentId: "agent_p", tool: "pattern_tool", args: { x: 1 } }), undefined);
    // The same pattern now matches the serialized args (case-insensitive).
    const matched = api.matchApprovalRule({ agentId: "agent_p", tool: "pattern_tool", args: { text: "please CONFIRM the dialog" } });
    assert.ok(matched);
    assert.equal(matched!.decision, "deny");
    // A "*" pattern matches any args.
    const anyRule = api.createApprovalRule({ tool: "pattern_any", pattern: "*", decision: "allow" });
    assert.equal(api.matchApprovalRule({ tool: "pattern_any", args: "anything" })!.id, anyRule.id);
    assert.equal(api.matchApprovalRule({ tool: "pattern_any", args: { a: [1, { b: 2 }] } })!.id, anyRule.id);
  });

  it("upserts rules and preserves identity across decision changes", () => {
    const first = api.createApprovalRule({ tool: "computer_ui_click", decision: "allow" });
    const second = api.createApprovalRule({ tool: "computer_ui_click", decision: "deny" });
    assert.equal(second.id, first.id);
    assert.equal(second.decision, "deny");
    assert.equal(api.listApprovalRules().filter((r) => r.tool === "computer_ui_click").length, 1);
  });

  it("deletes rules", () => {
    const rule = api.createApprovalRule({ tool: "computer_ui_set_text", decision: "allow" });
    assert.equal(api.deleteApprovalRule(rule.id), true);
    assert.equal(api.deleteApprovalRule(rule.id), false);
    assert.equal(api.matchApprovalRule({ tool: "computer_ui_set_text" }), undefined);
  });

  it("validates rule input", () => {
    assert.throws(() => api.createApprovalRule({ tool: "   ", decision: "allow" }), /tool is required/);
    assert.throws(() => api.createApprovalRule({ tool: "x", decision: "maybe" as unknown as "allow" }), /decision/);
  });

  it("replays the same decision for identical task/tool/args and never overwrites", () => {
    const key = api.approvalStableKey("task_r", undefined, "computer_click", { x: 1 });
    const keyAgain = api.approvalStableKey("task_r", undefined, "computer_click", { x: 1 });
    assert.equal(key, keyAgain);
    // Different tasks/tools/args produce different keys.
    assert.notEqual(key, api.approvalStableKey("task_r", undefined, "computer_click", { x: 2 }));
    assert.notEqual(key, api.approvalStableKey("task_s", undefined, "computer_click", { x: 1 }));
    // toolCallId keys are hash-free and stable (taskId + toolCallId per the spec).
    assert.equal(api.approvalStableKey("task_r", "call1", "computer_click", { x: 9 }), "task_r:call1");
    assert.notEqual(api.approvalStableKey("task_r", "call1", "t2", { x: 9 }), api.approvalStableKey("task_r", "call2", "t2", { x: 9 }));

    const first = api.saveApprovalDecision(key, "allow", "user");
    assert.equal(first.decision, "allow");
    // A conflicting later save must NOT change the stored decision (stored once).
    const second = api.saveApprovalDecision(key, "deny", "user");
    assert.equal(second.decision, "allow");
    assert.equal(api.getReplayDecision(key)!.decision, "allow");
    // Replays return the same decision repeatedly.
    assert.equal(api.getReplayDecision(key)!.decidedAt, first.decidedAt);
  });

  it("uses the decision_store for taskAuto toggle", () => {
    assert.equal(api.taskApprovalAuto("task_auto"), false);
    api.setTaskApprovalAuto("task_auto", true);
    assert.equal(api.taskApprovalAuto("task_auto"), true);
    api.setTaskApprovalAuto("task_auto", false);
    assert.equal(api.taskApprovalAuto("task_auto"), false);
  });
});
