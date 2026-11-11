import { dueSchedules, getTask, recordScheduleOutcome, type Schedule } from "./db.js";
import { getAgent } from "./agents.js";
import { log } from "../log.js";
import { DEFAULT_RETRY_DELAY_MS } from "./scheduleTime.js";

/**
 * True when the schedule is fired by its own trigger, not by the cron tick.
 *
 * `url-watch` has its own poller, `file-watch`/`service-watch` have their own
 * watchers, and the event triggers (webhook, github, slack, pagerduty, linear,
 * sentry) fire from the HTTP trigger route. Running any of these from the cron
 * loop as well would double-run them, so the scheduler skips them.
 */
function isEventTriggered(schedule: Schedule): boolean {
  if (schedule.kind === "url-watch" || schedule.kind === "file-watch" || schedule.kind === "service-watch") return true;
  return schedule.trigger !== undefined && schedule.trigger !== "cron";
}

export interface SchedulerDeps {
  runScheduled: (prompt: string, scheduleId: string, agentId?: string, workMode?: string) => Promise<string>;
  intervalMs?: number;
  /** MF2: delay before the single retry of a failed run (default 2 minutes). */
  retryDelayMs?: number;
  /** Interactive runs get priority; due routines stay pending while this is false. */
  canRun?: () => boolean;
}

export function startScheduler(deps: SchedulerDeps): () => void {
  const intervalMs = deps.intervalMs ?? 20_000;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy || !(deps.canRun?.() ?? true)) return;
    busy = true;
    try {
      for (const schedule of dueSchedules()) {
        // Archived companions keep their schedules but never run them.
        if (schedule.agentId && getAgent(schedule.agentId)?.archivedAt) continue;
        // Event-triggered routines (url-watch/file-watch/service-watch pollers and
        // webhook/github/... HTTP triggers) fire from their own path; the cron loop
        // must not run them too.
        if (isEventTriggered(schedule)) continue;
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