import { dueSchedules, getTask, recordScheduleOutcome } from "./db.js";
import { getAgent } from "./agents.js";
import { log } from "../log.js";
import { DEFAULT_RETRY_DELAY_MS } from "./scheduleTime.js";

export interface SchedulerDeps {
  runScheduled: (prompt: string, scheduleId: string, agentId?: string, workMode?: string) => Promise<string>;
  intervalMs?: number;
  /** MF2: delay before the single retry of a failed run (default 2 minutes). */
  retryDelayMs?: number;
}

export function startScheduler(deps: SchedulerDeps): () => void {
  const intervalMs = deps.intervalMs ?? 20_000;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      for (const schedule of dueSchedules()) {
        // Archived companions keep their schedules but never run them.
        if (schedule.agentId && getAgent(schedule.agentId)?.archivedAt) continue;
        const previous = schedule.lastTaskId ? getTask(schedule.lastTaskId) : undefined;
        if (previous && ["queued", "running", "interrupted"].includes(previous.status)) continue;
        log.info(`scheduler: running ${schedule.id} -> ${schedule.prompt.slice(0, 60)}`);
        try {
          const taskId = await deps.runScheduled(schedule.prompt, schedule.id, schedule.agentId, schedule.workMode);
          recordScheduleOutcome(schedule.id, { ok: true, taskId });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`scheduler: task failed for ${schedule.id}: ${message}`);
          // MF2 retry policy: exactly one retry after a short delay, then stop.
          // The routine keeps its cadence; lastStatus/attempts/lastError record why.
          recordScheduleOutcome(schedule.id, { ok: false, error: message, retryDelayMs });
        }
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}