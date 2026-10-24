/**
 * Wires the J7 hibernation manager to Loam's real derived caches and its real
 * busy-state guards.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md — the same conservative
 * boundary, now attached to this daemon's actual owners and guards:
 *
 * - **Owners** are derived, per-task, reconstructible caches. Each is already a
 *   bounded cache that reports to the J6 `debug:memory` surface, so dropping it
 *   costs nothing authoritative and the counters stay truthful. Nothing here
 *   owns canonical messages, tool definitions or captured instructions.
 * - **Guards** read the daemon's authoritative busy state: an in-flight run
 *   signal (a running tool or agent turn), a queued/running task, a durable
 *   pending input, or a scheduled routine about to fire. A guarded session is
 *   skipped by the sweep and reported in `skipped`, never force-released.
 *
 * Nothing here suspends a process, touches the network, or writes to disk. The
 * manager decides *when*; this module only says *what* and *whether it is safe*.
 */
import type { CacheOwner, HibernationGuard } from "./hibernation.js";
import { releaseTaskCaches, taskCacheBytes } from "./sessionCaches.js";
import { browserFrameOwner } from "../tools/browserFrames.js";
import { taskPhaseOwner } from "../tools/phaseTools.js";
import { executionQueue } from "../server/executionQueue.js";
import { getTask, listSchedules } from "../server/db.js";
import { hasPending } from "../server/inputQueue.js";
import { listRunningSignals } from "../server/runControl.js";

/** A session's derived caches, as named `CacheOwner`s the manager can release.
 *  Kept in one place so the daemon and the tests agree on what is droppable. */
export function sessionCacheOwners(taskId: string): CacheOwner[] {
  return [
    {
      name: "session-task-caches",
      size: () => taskCacheBytes(taskId).entries,
      bytes: () => taskCacheBytes(taskId).bytes,
      clear: () => { releaseTaskCaches(taskId); },
    },
    browserFrameOwner(taskId),
    taskPhaseOwner(taskId),
  ];
}

/** Busy-state guards for one session, read from the daemon's real state. */
export function sessionHibernationGuard(taskId: string): HibernationGuard {
  return {
    // A run signal exists for the whole run (created at queue time, cleared in
    // the run's finally), which covers the tool/agent turn in flight.
    running: () => runningSignalIds().includes(taskId) || executionQueue.has(taskId) || taskBusy(taskId),
    pendingInput: () => hasPending(taskId),
    scheduledWake: () => scheduleDueWithin(taskId, 60_000),
  };
}

/** Live in-flight run signals, read fresh so a test can mutate the registry. */
export function runningSignalIds(): string[] {
  return listRunningSignals();
}

/** A task the daemon still has to work on is not idle. */
export function taskBusy(taskId: string): boolean {
  const task = getTask(taskId);
  return !!task && (task.status === "running" || task.status === "queued" || task.status === "interrupted");
}

/** True when a routine targeting this task's companion is due within `withinMs`. */
export function scheduleDueWithin(taskId: string, withinMs: number): boolean {
  const task = getTask(taskId);
  if (!task?.agentId) return false;
  const now = Date.now();
  return listSchedules().some((schedule) => {
    if (!schedule.enabled || schedule.agentId !== task.agentId) return false;
    const at = Date.parse(schedule.nextRunAt);
    return Number.isFinite(at) && at - now <= withinMs;
  });
}
