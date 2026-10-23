/**
 * Plan mode control tool (C13) + pending plan approval (D4).
 *
 * `plan_exit` is the escape hatch from the read-only `plan` permission mode. The
 * agent assembles its plan (summary, ordered steps and the files it would edit),
 * presents it through the existing approval layer so the user sees a normal
 * ApprovalCard, and — only once the user approves — switches the task to
 * acceptEdits (`approve_for_me`). Until then every mutating tool call is refused
 * by the plan-mode gate (see `gateToolCallForPermissionMode`).
 *
 * The tool never mutates anything itself; it only decides whether the task leaves
 * plan mode. Denial leaves the task exactly where it was.
 *
 * `suggest_plan` is the Devin-parity variant: it presents the plan and blocks
 * every mutating tool call while the plan is pending approval
 * (`applyPlanApprovalGate`), but it does not change the task's permission mode —
 * the task stays exactly where it was. The user approves/edits/rejects through
 * the plan-approval route (`src/server/routes/planApproval.ts`) and the web
 * plan-approval card.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str, strs } from "./registry.js";
import { createApproval, waitForDecision } from "../server/approvals.js";
import { setTaskPermissionMode, taskPermissionMode } from "../server/approvalRules.js";
import {
  ACCEPT_EDITS_MODE,
  DEFAULT_PERMISSION_MODE,
  gateToolCallForPermissionMode,
  isPlanMode,
  type LocalPermissionMode,
  type PermissionGateDecision,
} from "../policy/permissionModes.js";
import {
  SUGGEST_PLAN_TOOL,
  formatSuggestPlanPreview,
  gateToolCallForPendingPlan,
  parseSuggestPlanArgs,
  pendingPlanBlockedMessage,
  type SuggestPlanArgs,
} from "./planApprovalGate.js";
import { createPlanApproval, waitForPlanDecision } from "./planApprovalStore.js";

export const PLAN_EXIT_TOOL = "plan_exit";

/** Gate every tool call so a pending plan blocks mutating actions (D4). */
export function applyPlanApprovalGate(registry: PlanGateRegistry, opts: PlanGateOptions): void {
  const { taskId, workspaceRoot } = opts;
  for (const name of registry.names()) {
    // `suggest_plan` itself must stay available: the model needs it to
    // re-present a plan after an edit, and it never mutates anything.
    if (name === SUGGEST_PLAN_TOOL) continue;
    const original = registry.get(name);
    if (!original) continue;
    registry.replaceTool({
      ...original,
      async run(args, ctx) {
        const decision = gateToolCallForPendingPlan(ctx.taskId ?? taskId, name, args, workspaceRoot);
        if (!decision.allowed) {
          return { ok: false, content: pendingPlanBlockedMessage(decision.pendingPlan!, decision.reason) };
        }
        return original.run(args, ctx);
      },
    });
  }
}

export { SUGGEST_PLAN_TOOL, formatSuggestPlanPreview, parseSuggestPlanArgs };
export type { SuggestPlanArgs };

/** The registry surface the plan gate needs (a `ToolRegistry` or a filtered sub). */
export interface PlanGateRegistry {
  names(): string[];
  get(name: string): Tool | undefined;
  replaceTool(tool: Tool): void;
}

export interface PlanGateOptions {
  /** Task the run is executing; the persisted mode is read per call. */
  taskId: string;
  /** Workspace root used to resolve write paths while classifying a call. */
  workspaceRoot: string;
}

/** The refusal message shown to the model when plan mode blocks a call. */
export function planModeBlockedMessage(reason?: string): string {
  return `Plan mode is read-only: ${reason ?? "this action is blocked"}. Present your plan with plan_exit and wait for approval before editing files or running commands.`;
}

/**
 * Wrap every tool except `plan_exit` so that, while the task is in the read-only
 * `plan` mode, each call is classified and refused before it runs. The wrapper
 * re-reads the persisted mode on every call, so once `plan_exit` is approved and
 * the task switches to acceptEdits later edits in the same run are allowed.
 */
export function applyPlanModeGate(registry: PlanGateRegistry, opts: PlanGateOptions): void {
  const { taskId, workspaceRoot } = opts;
  for (const name of registry.names()) {
    if (name === PLAN_EXIT_TOOL) continue;
    const original = registry.get(name);
    if (!original) continue;
    registry.replaceTool({
      ...original,
      async run(args, ctx) {
        const mode = taskPermissionMode(ctx.taskId ?? taskId) ?? DEFAULT_PERMISSION_MODE;
        if (!isPlanMode(mode)) return original.run(args, ctx);
        const decision: PermissionGateDecision = gateToolCallForPermissionMode("plan", name, args, workspaceRoot);
        if (!decision.allowed) {
          return { ok: false, content: planModeBlockedMessage(decision.reason) };
        }
        return original.run(args, ctx);
      },
    });
  }
}

/** Human-readable plan payload accepted by `plan_exit`. */
export interface PlanExitArgs {
  summary: string;
  steps: string[];
  filesToEdit: string[];
}

/** Normalise and validate raw `plan_exit` arguments. */
export function parsePlanExitArgs(args: Record<string, unknown>): PlanExitArgs | { error: string } {
  const summary = str(args, "summary").trim();
  if (!summary) return { error: "plan_exit requires a non-empty summary describing the plan" };
  if (summary.length > 4000) return { error: "plan_exit summary must be 4000 characters or fewer" };
  const steps = strs(args, "steps").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 50);
  const filesToEdit = strs(args, "files_to_edit").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 200);
  return { summary, steps, filesToEdit };
}

/** Render a plan as a compact preview for the approval card. */
export function formatPlanPreview(plan: PlanExitArgs): string {
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

export function createPlanTools(): Tool[] {
  return [
    {
      name: SUGGEST_PLAN_TOOL,
      description:
        "Present your implementation plan to the user for approval before making any change. " +
        "Call this once you have finished exploring and know what you will do. " +
        "Provide a concise summary of the outcome, the ordered steps, every file you will create or modify (files_to_edit must list all edit locations), and set trivial=true only for a single obvious action. " +
        "While the plan is pending, mutating tools (file write/edit, shell commands with side effects, destructive and secret actions) are refused, so call this BEFORE you start editing. " +
        "The plan is shown in a plan-approval card; when the user approves, you may proceed. When the user edits it, re-present the revised plan with suggest_plan. When the user rejects it, return to planning and do not edit anything. " +
        "When NOT to use: do not call this tool to ask a question or to report progress — use the message tool for that.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: {
            type: "string",
            maxLength: 4000,
            description: "One-paragraph statement of the outcome the plan will deliver.",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Ordered implementation steps, each a short imperative sentence.",
          },
          files_to_edit: {
            type: "array",
            items: { type: "string" },
            description: "Workspace-relative paths the plan will create or modify. List every edit location.",
          },
          trivial: {
            type: "boolean",
            description:
              "True only for a single obvious action (one file, a few lines, one command). " +
              "When the user enabled the skip-trivial-plan-approval setting, a trivial plan is approved automatically.",
          },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parsed = parseSuggestPlanArgs(args);
        if ("error" in parsed) return { ok: false, content: parsed.error };
        const plan: SuggestPlanArgs = parsed;
        const taskId = ctx.taskId ?? "";
        if (!taskId) {
          return { ok: false, content: "suggest_plan requires an active task; no task is attached to this run." };
        }

        const record = createPlanApproval({ taskId, plan });
        ctx.emit({
          type: "plan_approval_required",
          planApprovalId: record.id,
          taskId,
          tool: SUGGEST_PLAN_TOOL,
          summary: record.summary,
          steps: record.steps,
          filesToEdit: record.filesToEdit,
          trivial: record.trivial,
        });

        const status = await waitForPlanDecision(record.id, ctx.signal);
        if (status !== "approved") {
          const edited = status === "edited";
          const detail =
            status === "rejected"
              ? "the user rejected the plan"
              : edited
                ? "the user edited the plan"
                : `the plan ${status}`;
          const revised = edited ? formatSuggestPlanPreview(record.editedPlan ?? plan) : "";
          return {
            ok: false,
            content:
              `suggest_plan was not approved (${detail}); no files were changed. ` +
              (edited
                ? `Re-present the revised plan below with suggest_plan before editing anything:\n\n${revised}`
                : "Return to planning, revise the plan and present it again."),
          };
        }

        return {
          ok: true,
          content: `Plan approved — you may now edit files and run commands.\n\n${formatSuggestPlanPreview(plan)}`,
        };
      },
    },
    {
      name: PLAN_EXIT_TOOL,
      description:
        "Present your implementation plan to the user for approval and leave read-only plan mode. " +
        "Call this only after you have finished exploring and are ready to make changes. " +
        "Provide a concise summary of what you will do, the ordered steps you will follow, and the files you will edit. " +
        "The plan is shown in an approval card; when the user approves, the task switches to acceptEdits and file edits, shell commands and other mutating actions become allowed. " +
        "When the user denies the plan, nothing changes and plan mode stays active, so revise the plan and try again. " +
        "When NOT to use: do not call this tool to ask a question or to report progress — use the message tool for that. " +
        "Do not attempt edits before the plan is approved; they will be refused while plan mode is active.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: {
            type: "string",
            maxLength: 4000,
            description: "One-paragraph statement of the outcome the plan will deliver.",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Ordered implementation steps, each a short imperative sentence.",
          },
          files_to_edit: {
            type: "array",
            items: { type: "string" },
            description: "Workspace-relative paths the plan will create or modify.",
          },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parsed = parsePlanExitArgs(args);
        if ("error" in parsed) return { ok: false, content: parsed.error };
        const plan = parsed;

        const approval = createApproval({
          taskId: ctx.taskId ?? "",
          tool: PLAN_EXIT_TOOL,
          summary: `Plan for approval: ${plan.summary}`,
          argsPreview: JSON.stringify({ summary: plan.summary, steps: plan.steps, files_to_edit: plan.filesToEdit }),
        });
        ctx.emit({ type: "approval_required", approvalId: approval.id, tool: PLAN_EXIT_TOOL, summary: approval.summary });

        const decision = await waitForDecision(approval.id, ctx.signal);
        if (decision !== "approved") {
          const detail = decision === "denied" ? "the user denied the plan" : `the approval ${decision}`;
          return {
            ok: false,
            content: `plan_exit was not approved (${detail}); plan mode is still read-only. Revise the plan and present it again.`,
          };
        }

        const previousMode: LocalPermissionMode = ctx.taskId ? (taskPermissionMode(ctx.taskId) ?? DEFAULT_PERMISSION_MODE) : DEFAULT_PERMISSION_MODE;
        if (ctx.taskId) {
          setTaskPermissionMode(ctx.taskId, ACCEPT_EDITS_MODE);
          ctx.emit({
            type: "permission_mode_changed",
            mode: ACCEPT_EDITS_MODE,
            previousMode,
            reason: plan.summary,
          });
        }
        return {
          ok: true,
          content: `Plan approved — switched to ${ACCEPT_EDITS_MODE} (acceptEdits). You may now edit files and run commands.\n\n${formatPlanPreview(plan)}`,
        };
      },
    },
  ];
}
