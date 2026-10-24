/**
 * Policy gate for codemode tool calls.
 *
 * A script can only reach the outside world through `tools.<name>(args)`, so
 * every one of those calls goes through the same gate as a normal tool call:
 * the risk-tier matrix, saved approval rules, the per-task "Approve for me"
 * toggle, and the plan-mode read-only restriction. A denied call is reported to
 * the script as an ordinary tool failure, never as a sandbox escape.
 *
 * Adapted from jcode (MIT) ref/codemode/lib.rs (the `Host::call_tool` contract)
 * onto Loam's policy modules.
 */
import {
  classifyToolCall,
  decideGate,
  resolveGate,
  type RiskTier,
  type SandboxMode,
} from "../policy/riskTier.js";
import { gateToolCallForPermissionMode, permissionModeSandboxMode, type LocalPermissionMode } from "../policy/permissionModes.js";
import { approvalStableKey, getReplayDecision, matchApprovalRule, saveApprovalDecision, taskApprovalAuto, taskSandboxMode, taskPermissionMode } from "../server/approvalRules.js";
import { createApproval, waitForDecision } from "../server/approvals.js";
import type { Emit } from "../agent/events.js";

export interface CodemodeGateInput {
  taskId: string;
  /** Owning companion agent; null for anonymous runs. */
  agentId?: string | null;
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  /** Per-task permission mode; defaults to `approve_for_me`. */
  permissionMode?: LocalPermissionMode;
  /** Emit an approval_required event so the UI shows a card. */
  emit?: Emit;
  /** Cancels the wait when the run is stopped. */
  signal?: AbortSignal;
}

export interface CodemodeGate {
  /** Approve one call; returns the refusal message, or undefined when allowed. */
  authorize(toolName: string, args: Record<string, unknown>): Promise<string | undefined>;
}

/** The risk tier of one script tool call (exported for tests/diagnostics). */
export function codemodeTier(toolName: string, args: Record<string, unknown>, workspaceRoot: string): RiskTier {
  return classifyToolCall(toolName, args, workspaceRoot);
}

/**
 * Build the gate for one run. The sandbox mode is resolved once (config default
 * < per-task override), and the permission mode is re-read per call so a
 * plan-mode exit later in the same run takes effect immediately.
 */
export function createCodemodeGate(input: CodemodeGateInput): CodemodeGate {
  // Plan mode is read-only by construction, so it wins over the sandbox mode
  // passed in (which is the config default, not the task's current mode). It is
  // re-read per call below so a plan-mode exit takes effect immediately.
  const effectiveSandbox: SandboxMode = taskSandboxMode(input.taskId) ?? input.sandboxMode;
  const permissionMode = (): LocalPermissionMode => taskPermissionMode(input.taskId) ?? input.permissionMode ?? "approve_for_me";

  const authorize = async (toolName: string, args: Record<string, unknown>): Promise<string | undefined> => {
    const mode = permissionMode();
    const inPlanMode = mode === "plan";

    // Plan mode is strictly read-only: mutating tiers are refused outright, and
    // the refusal never becomes an approval card.
    if (inPlanMode) {
      const planDecision = gateToolCallForPermissionMode("plan", toolName, args, input.workspaceRoot);
      if (!planDecision.allowed) return planDecision.reason ?? `${toolName} is not allowed in plan mode`;
    }

    const tier = classifyToolCall(toolName, args, input.workspaceRoot);
    const sandbox = inPlanMode ? permissionModeSandboxMode("plan") : effectiveSandbox;
    const base = decideGate(sandbox, tier);
    if (base === "allow") return undefined;
    if (base === "deny") return `${tier} is denied in ${sandbox} mode`;

    // "ask": replay a saved decision first, then a saved rule, then the task
    // toggle, and only prompt when none of them decides. Tier-scoped rules are
    // respected (destructive/secret need a rule naming that exact tier).
    const stableKey = approvalStableKey(input.taskId, undefined, toolName, args);
    const replay = getReplayDecision(stableKey);
    if (replay) {
      if (replay.decision === "allow") return undefined;
      return `the user denied this ${tier} action`;
    }
    const rule = matchApprovalRule({ agentId: input.agentId ?? null, tool: toolName, args });
    const autoForTask = taskApprovalAuto(input.taskId);
    const resolved = resolveGate({ mode: sandbox, tier, rule: rule ?? null, autoApprove: autoForTask });
    if (resolved.decision === "allow") {
      saveApprovalDecision(stableKey, "allow", resolved.source === "auto" ? "auto" : "rule");
      return undefined;
    }
    if (resolved.decision === "deny") {
      saveApprovalDecision(stableKey, "deny", resolved.source === "auto" ? "auto" : "rule");
      return `the user denied this ${tier} action`;
    }

    const approval = createApproval({
      taskId: input.taskId,
      tool: toolName,
      summary: `codemode wants to run ${toolName} (${tier})`,
      argsPreview: JSON.stringify(args ?? {}).slice(0, 300),
    });
    input.emit?.({ type: "approval_required", approvalId: approval.id, tool: toolName, summary: approval.summary });
    const status = await waitForDecision(approval.id, input.signal);
    saveApprovalDecision(stableKey, status === "approved" ? "allow" : "deny", "user");
    if (status !== "approved") {
      return status === "denied"
        ? `the user denied this ${tier} action`
        : `approval expired (${status}) before this ${tier} action ran`;
    }
    return undefined;
  };

  return { authorize };
}
