import { dueSchedules, markScheduleRun, getTask } from "./db.js";
import { getAgent } from "./agents.js";
import { log } from "../log.js";

export interface SchedulerDeps {
  runScheduled: (prompt: string, scheduleId: string, agentId?: string, workMode?: string) => Promise<string>;
  intervalMs?: number;
}

export function startScheduler(deps: SchedulerDeps): () => void {
  const intervalMs = deps.intervalMs ?? 20_000;
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
          markScheduleRun(schedule.id, taskId);
        } catch (err) {
          log.warn(`scheduler: task failed for ${schedule.id}: ${err instanceof Error ? err.message : String(err)}`);
          // queueTaskRun records the actual task id atomically before dispatch.
          // Do not replace it with the previous invocation's id on failure.
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
