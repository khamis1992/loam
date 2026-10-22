/**
 * Plan mode control tool (C13).
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

export const PLAN_EXIT_TOOL = "plan_exit";

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
      name: PLAN_EXIT_TOOL,
      description:
        "Present your implementation plan to the user for approval and leave read-only plan mode. " +
        "Call this only after you have finished exploring and are ready to make changes. " +
        "Provide a concise summary of what you will do, the ordered steps you will follow, and the files you will edit. " +
        "The plan is shown in an approval card; when the user approves, the task switches to acceptEdits and file edits, shell commands and other mutating actions become allowed. " +
        "When the user denies the plan, nothing changes and plan mode stays active, so revise the plan and try again. " +
        "Do not call this tool to ask a question or to report progress — use the message tool for that. " +
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
