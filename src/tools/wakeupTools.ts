/**
 * Neo N8: Agent-initiated recurring wake-ups.
 *
 * Tools allowing agents to schedule recurring or one-shot wake-ups against the
 * existing scheduler (e.g. intervalSeconds or cron, optional until deadline,
 * optional instruction prompt), and to cancel existing wake-ups.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str, num } from "./registry.js";
import { addSchedule, deleteSchedule, getSchedule, getTask, listSchedules } from "../server/db.js";
import { DEFAULT_TIMEZONE, isValidTimezone, parseCron } from "../server/scheduleTime.js";

export const SCHEDULE_WAKEUP_TOOL = "schedule_wakeup";
export const CANCEL_WAKEUP_TOOL = "cancel_wakeup";

export function createWakeupTools(): Tool[] {
  return [
    {
      name: SCHEDULE_WAKEUP_TOOL,
      description:
        "Schedule an agent wake-up (recurring interval or cron expression) with an optional instruction and until boundary. Resumes the mission or starts a scheduled round with new round subtrees on the run graph.",
      parameters: {
        type: "object",
        properties: {
          intervalSeconds: {
            type: "number",
            description: "Wake-up interval in seconds (minimum 30 seconds). Required if cron is omitted.",
          },
          cron: {
            type: "string",
            description: "5-field cron expression (e.g. '0 9 * * 1' or '*/5 * * * *'). Evaluated in timezone.",
          },
          timezone: {
            type: "string",
            description: "IANA timezone for cron evaluation (default Asia/Qatar).",
          },
          runAt: {
            type: "string",
            description: "One-shot ISO timestamp for single wake-up (e.g. '2026-10-25T12:00:00Z').",
          },
          until: {
            type: "string",
            description: "ISO timestamp boundary after which recurring wake-ups must stop.",
          },
          instruction: {
            type: "string",
            description: "Prompt or instruction to execute upon waking up (defaults to the mission prompt).",
          },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = ctx.taskId;
        const currentTask = taskId ? getTask(taskId) : undefined;
        const instruction = str(args, "instruction").trim();
        const prompt = instruction || currentTask?.prompt || "Scheduled mission wakeup";
        const cron = str(args, "cron").trim() || undefined;
        const runAt = str(args, "runAt").trim() || undefined;
        const timezone = str(args, "timezone").trim() || undefined;
        const until = str(args, "until").trim() || undefined;
        const intervalSeconds = num(args, "intervalSeconds", 0);

        if (!cron && !runAt && intervalSeconds <= 0) {
          return {
            ok: false,
            content: "schedule_wakeup requires at least one of intervalSeconds, cron, or runAt",
          };
        }

        if (cron) {
          try {
            parseCron(cron);
          } catch (err) {
            return {
              ok: false,
              content: `invalid cron expression '${cron}': ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        if (timezone && !isValidTimezone(timezone)) {
          return {
            ok: false,
            content: `unknown timezone '${timezone}'`,
          };
        }

        if (until) {
          const untilMs = Date.parse(until);
          if (!Number.isFinite(untilMs)) {
            return {
              ok: false,
              content: `invalid until ISO timestamp: '${until}'`,
            };
          }
        }

        const agentId = ctx.agentId || currentTask?.agentId || undefined;
        const workMode = currentTask?.mode || undefined;

        try {
          const schedule = addSchedule(
            prompt,
            intervalSeconds > 0 ? intervalSeconds : 3600,
            agentId,
            workMode,
            "cron",
            undefined,
            true,
            {
              cron,
              runAt,
              timezone: timezone ?? DEFAULT_TIMEZONE,
              until,
              missionId: taskId,
              instruction: instruction || undefined,
              round: 1,
            },
          );

          // Emit event to inform run graph and listeners
          ctx.emit?.({
            type: "wakeup_scheduled",
            scheduleId: schedule.id,
            nextRunAt: schedule.nextRunAt,
            intervalSeconds: schedule.intervalSeconds,
            ...(cron ? { cron } : {}),
            ...(until ? { until } : {}),
            ...(instruction ? { instruction } : {}),
          });

          return {
            ok: true,
            content: `Wake-up scheduled successfully with ID '${schedule.id}'. Next run at ${schedule.nextRunAt}${until ? ` until ${until}` : ""}.`,
          };
        } catch (err) {
          return {
            ok: false,
            content: `schedule_wakeup failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    {
      name: CANCEL_WAKEUP_TOOL,
      description: "Cancel an active scheduled wake-up by scheduleId (or cancel all wake-ups for this mission/agent).",
      parameters: {
        type: "object",
        properties: {
          scheduleId: {
            type: "string",
            description: "The schedule ID to cancel. If omitted, cancels active wake-ups for current mission/agent.",
          },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const scheduleId = str(args, "scheduleId").trim();
        const taskId = ctx.taskId;

        if (scheduleId) {
          const sched = getSchedule(scheduleId);
          if (!sched) {
            return {
              ok: false,
              content: `Schedule '${scheduleId}' not found.`,
            };
          }
          const deleted = deleteSchedule(scheduleId);
          ctx.emit?.({
            type: "wakeup_cancelled",
            scheduleId,
          });
          return {
            ok: deleted,
            content: deleted ? `Schedule '${scheduleId}' cancelled successfully.` : `Failed to cancel schedule '${scheduleId}'.`,
          };
        }

        // Cancel wake-ups matching current mission or agent
        if (taskId) {
          const matching = listSchedules().filter((s) => s.missionId === taskId || s.lastTaskId === taskId);
          let count = 0;
          for (const s of matching) {
            if (deleteSchedule(s.id)) {
              count++;
              ctx.emit?.({
                type: "wakeup_cancelled",
                scheduleId: s.id,
              });
            }
          }
          return {
            ok: true,
            content: `Cancelled ${count} wake-up(s) for mission '${taskId}'.`,
          };
        }

        return {
          ok: false,
          content: "cancel_wakeup requires scheduleId when no mission taskId is active",
        };
      },
    },
  ];
}
