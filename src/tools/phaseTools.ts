import type { WorkPhase } from "../agent/events.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

const WORK_PHASES: readonly WorkPhase[] = ["chat", "plan", "build", "verify"];

/** Current work phase per task, shared across the process lifetime. Bounded
 *  (J6): a long-lived server sees thousands of tasks, so only the most recently
 *  touched task phases are retained. */
const taskPhases = new BoundedMap<string, WorkPhase>(512, "task-phases");
registerCacheStats("task-phases", () => taskPhases.stats());

/** Read the stored work phase for a task, or undefined when it was never set. */
export function getTaskPhase(taskId: string): WorkPhase | undefined {
  return taskPhases.get(taskId);
}

export function createPhaseTools(): Tool[] {
  return [
    {
      name: "phase_set",
      description: "Set the current work phase for this task (chat, plan, build, verify).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "reason"],
        properties: {
          phase: { enum: [...WORK_PHASES] },
          reason: { type: "string", maxLength: 400, description: "Why the phase is changing." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const phase = str(args, "phase");
        if (!WORK_PHASES.includes(phase as WorkPhase)) {
          return { ok: false, content: `unknown phase ${JSON.stringify(phase)}; expected one of ${WORK_PHASES.join(", ")}` };
        }
        const reason = str(args, "reason").trim();
        if (!reason) return { ok: false, content: "phase_set requires a non-empty reason" };
        if (!ctx.taskId) return { ok: false, content: "phase_set requires a task context (taskId)" };

        const previous = taskPhases.get(ctx.taskId) ?? "chat";
        taskPhases.set(ctx.taskId, phase as WorkPhase);
        ctx.emit({ type: "phase", phase: phase as WorkPhase, reason });
        return { ok: true, content: `${previous} -> ${phase}: ${reason}` };
      },
    },
  ];
}
