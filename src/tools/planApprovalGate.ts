/**
 * Pending plan approval (D4, Devin `suggest_plan`).
 *
 * `suggest_plan` is the agent's way to request user approval of a plan before
 * any mutating tool runs. The tool stores the plan in the pending store
 * (`planApprovalStore.ts`), emits a `plan_approval_required` event (rendered by
 * the web client as a plan-approval card) and blocks until the user approves,
 * edits or rejects it through the HTTP route in
 * `src/server/routes/planApproval.ts`.
 *
 * This module owns the plan payload type, argument parsing, preview rendering
 * and the pure classifier that decides which tool calls are blocked while a plan
 * is pending. The store/wait primitives live in `planApprovalStore.ts` so the
 * classifier can be imported without pulling the server store into a boundary.
 *
 * The trivial-task bypass is a settings preference
 * (`settings.planApprovalSkipTrivial`): when it is on, a plan the agent marks
 * `trivial` is auto-approved, so single-action requests never stop for a card.
 */
import { classifyToolCall, type RiskTier } from "../policy/riskTier.js";
import { pendingPlanForTask } from "./planApprovalStore.js";

export const SUGGEST_PLAN_TOOL = "suggest_plan";

/** Plan payload accepted by `suggest_plan` (Devin's argument shape). */
export interface SuggestPlanArgs {
  summary: string;
  steps: string[];
  filesToEdit: string[];
  /** Single-action task: the settings preference can auto-approve it. */
  trivial: boolean;
}

export type PlanApprovalStatus = "pending" | "approved" | "edited" | "rejected" | "expired";

export interface PlanApprovalRecord {
  id: string;
  taskId: string;
  summary: string;
  steps: string[];
  filesToEdit: string[];
  trivial: boolean;
  status: PlanApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  /** The plan the agent must re-present when the user edited it. */
  editedPlan?: SuggestPlanArgs;
}

/** How the user decided a pending plan. `edited` carries the revised plan. */
export interface PlanApprovalDecision {
  decision: "approve" | "reject" | "edit";
  /** Revised plan payload; accepts either the model shape (`filesToEdit`) or the
   *  wire shape (`files_to_edit`) used by the HTTP route and the socket. */
  plan?: Partial<SuggestPlanArgs> & { files_to_edit?: string[] };
}

/** Normalise and validate raw `suggest_plan` arguments. */
export function parseSuggestPlanArgs(args: Record<string, unknown>): SuggestPlanArgs | { error: string } {
  const raw = (args as { summary?: unknown }).summary;
  const summary = typeof raw === "string" ? raw.trim() : "";
  if (!summary) return { error: "suggest_plan requires a non-empty summary describing the plan" };
  if (summary.length > 4000) return { error: "suggest_plan summary must be 4000 characters or fewer" };
  const steps = Array.isArray(args.steps)
    ? (args.steps.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 50))
    : [];
  const filesToEdit = Array.isArray(args.files_to_edit)
    ? (args.files_to_edit.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 200))
    : [];
  return { summary, steps, filesToEdit, trivial: args.trivial === true };
}

/** Render a plan as a compact preview for the card and the tool result. */
export function formatSuggestPlanPreview(plan: SuggestPlanArgs): string {
  const lines = [plan.summary];
  if (plan.steps.length > 0) {
    lines.push("", "Steps:");
    plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  if (plan.filesToEdit.length > 0) {
    lines.push("", "Files to edit:");
    for (const file of plan.filesToEdit) lines.push(`- ${file}`);
  }
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Gate: which calls are blocked while a plan is pending
// ----------------------------------------------------------------------------

/**
 * Tiers allowed while a plan is pending: reads and read-only web research.
 * Everything else (writes, commands, destructive, secret) is blocked.
 */
const PLAN_APPROVAL_ALLOWED_TIERS: ReadonlySet<RiskTier> = new Set<RiskTier>(["read", "network-external"]);

export interface PlanApprovalGateDecision {
  allowed: boolean;
  /** The plan awaiting a decision, when the call was blocked. */
  pendingPlan?: PlanApprovalRecord;
  reason?: string;
}

/**
 * Decide whether one tool call may run while a task's plan is pending.
 *
 * The classification is the same risk tier used by the permission-mode gate, so
 * a pending plan blocks exactly the mutating surface (file write/edit, shell
 * with side effects, destructive and secret actions) while reads and read-only
 * research still work.
 */
export function gateToolCallForPendingPlan(
  taskId: string,
  toolName: string,
  args?: Record<string, unknown> | null,
  workspaceRoot: string = process.cwd(),
): PlanApprovalGateDecision {
  const pending = pendingPlanForTask(taskId);
  if (!pending) return { allowed: true };
  const tier = classifyToolCall(toolName, args, workspaceRoot);
  if (PLAN_APPROVAL_ALLOWED_TIERS.has(tier)) return { allowed: true, pendingPlan: pending };
  return {
    allowed: false,
    pendingPlan: pending,
    reason: `${tier} actions are blocked until the plan is approved`,
  };
}

/** The refusal message shown to the model when a pending plan blocks a call. */
export function pendingPlanBlockedMessage(plan: PlanApprovalRecord, reason?: string): string {
  return (
    `A plan for this task is awaiting your approval: ${reason ?? "mutating actions are blocked"}. ` +
    `Call suggest_plan with the revised plan (summary, steps, files_to_edit) and wait for the user's decision before editing files or running commands.`
  );
}

/** True when the task's plan is pending and this call is not read-only. */
export function isBlockedByPendingPlan(
  taskId: string,
  toolName: string,
  args?: Record<string, unknown> | null,
  workspaceRoot = process.cwd(),
): boolean {
  return !gateToolCallForPendingPlan(taskId, toolName, args, workspaceRoot).allowed;
}
