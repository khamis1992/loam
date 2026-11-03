/**
 * Budget policy tools (Strix `--max-budget` parity).
 *
 * `budget_pause` parks a running task before its next model call; the task
 * keeps its transcript and checkpoint and `budget_resume` continues it (raise
 * the ceiling first with the session runtime when it was the ceiling that
 * tripped). `budget_status` reports the counters and the pause state so the
 * model can decide before it burns another step.
 */
import { budgetPauseSnapshot, isBudgetPaused, pauseBudget, resumeBudget } from "../agent/budgetPause.js";
import { formatBudgetUsage } from "../agent/computeBudget.js";
import { sessionRuntime } from "../server/sessionRuntime.js";
import { getTask } from "../server/db.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

function taskFor(args: Record<string, unknown>, ctx: ToolContext): string {
  return str(args, "task_id").trim() || ctx.taskId || "";
}

export function createBudgetTools(): Tool[] {
  return [
    {
      name: "budget_pause",
      description:
        "Park the current run before its next model call because the budget is running out. The run keeps its transcript (a pause is not a stop): budget_resume continues from the same step, optionally after the ceiling is raised. Use it to checkpoint before an expensive phase or to hand control back to the operator. When NOT to use: for a hard end use finish; for user input use ask_user.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task to pause. Defaults to the current task." },
          reason: { type: "string", description: "Why the run is parking, shown to the operator." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        if (!taskId) return { ok: false, content: "budget_pause needs a task id (no current task)" };
        const reason = str(args, "reason").trim() || "paused by the agent";
        const state = pauseBudget(taskId, reason);
        ctx.emit({ type: "budget_paused", taskId, reason: state.reason });
        return {
          ok: true,
          content: `task ${taskId} will park before its next model call (reason: ${state.reason}). Call budget_resume (and raise the session budget) to continue.`,
        };
      },
    },
    {
      name: "budget_resume",
      description:
        "Resume a task parked with budget_pause. Raise the ceiling first (POST /api/sessions/:id/budget) when the budget itself tripped, or the run parks again on the next step.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task to resume. Defaults to the current task." },
          steps: { type: "number", description: "Steps to add to the ceiling before resuming." },
          tokens: { type: "number", description: "Tokens to add to the ceiling before resuming." },
          minutes: { type: "number", description: "Wall-clock minutes to add to the ceiling before resuming." },
          cost_usd: { type: "number", description: "USD to add to the cost ceiling before resuming." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        if (!taskId) return { ok: false, content: "budget_resume needs a task id (no current task)" };
        const num = (key: string): number | undefined => {
          const value = args[key];
          return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
        };
        const steps = num("steps");
        const tokens = num("tokens");
        const minutes = num("minutes");
        const costUsd = num("cost_usd");
        let raised = false;
        if (steps !== undefined || tokens !== undefined || minutes !== undefined || costUsd !== undefined) {
          const result = sessionRuntime.raise(taskId, {
            ...(steps !== undefined ? { steps: Math.floor(steps) } : {}),
            ...(tokens !== undefined ? { tokens: Math.floor(tokens) } : {}),
            ...(minutes !== undefined ? { wallClockMs: Math.floor(minutes * 60_000) } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          });
          if (!result.ok) return { ok: false, content: `budget not raised: ${result.reason ?? "invalid increase"}` };
          sessionRuntime.resumeAfterRaise(taskId);
          raised = true;
        }
        const epoch = resumeBudget(taskId);
        if (epoch === undefined && !raised) return { ok: false, content: `task ${taskId} is not paused` };
        ctx.emit({ type: "budget_resumed", taskId, epoch: epoch ?? 0, raised });
        return { ok: true, content: `task ${taskId} resumed${raised ? " with a raised ceiling" : ""}${epoch === undefined ? " (was not paused)" : ""}.` };
      },
    },
    {
      name: "budget_status",
      description: "Show a task's compute budget counters, ceiling verdict and whether it is parked on the budget.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "Task to inspect. Defaults to the current task." } },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        if (!taskId) return { ok: false, content: "budget_status needs a task id (no current task)" };
        const budget = sessionRuntime.getBudget(taskId);
        const paused = budgetPauseSnapshot(taskId);
        const task = getTask(taskId);
        return {
          ok: true,
          content: JSON.stringify(
            {
              task_id: taskId,
              status: task?.status ?? "unknown",
              usage: formatBudgetUsage(budget),
              warning: sessionRuntime.lastWarning(taskId),
              stopped_on_budget: sessionRuntime.isStoppedOnBudget(taskId),
              pause: paused,
              paused_here: isBudgetPaused(taskId),
            },
            null,
            2,
          ),
        };
      },
    },
  ];
}
