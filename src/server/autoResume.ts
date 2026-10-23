/**
 * O6b startup auto-resume (BUILD_SPEC §9 flowchart, GAP_TABLE row 12).
 *
 * Phase 2 of recovery: when `LOAM_AUTO_RESUME=1` (default off) an interrupted
 * task continues on the next boot **without** human review, but only when its
 * latest checkpoint is provably idle. Anything else keeps today's behaviour
 * (`recoverInterruptedTasks` marks the task `interrupted` and the UI shows
 * "Resume requires review").
 *
 * Idle means the durable event log says the run is safe to continue:
 * - the newest checkpoint event has `inFlight === false`, and
 * - no tool call started without reaching a terminal event.
 *
 * The second half is not redundant: the orchestrator writes a checkpoint
 * *before* a worker runs (`checkpoint(true)`), so a crash inside the step leaves
 * `inFlight: true` on disk while an older, idle checkpoint is still in the log.
 * The log is the authority for "what is the newest state", and
 * `requiresReplayConfirmation` already encodes exactly that question, so the
 * decision here reuses it instead of growing a second copy of the rule.
 *
 * A checkpoint that was never mirrored into the log (`logSessionId` unset) has
 * no evidence that it is idle, so it is refused rather than resumed.
 */
import fs from "node:fs";
import path from "node:path";
import { executionQueue } from "./executionQueue.js";
import { getSavedRun, listTasks, type Task } from "./db.js";
import { requiresReplayConfirmation, type SavedRun } from "./recovery.js";
import { readLatestCheckpoint } from "../agent/checkpointLog.js";
import type { Emit } from "../agent/events.js";
import { log } from "../log.js";

/** Why an interrupted task was not auto-resumed. Logged, never sent to the UI. */
export type AutoResumeSkipReason =
  | "no-saved-run"
  | "not-interrupted"
  | "no-checkpoint"
  | "in-flight"
  | "no-log-evidence"
  | "unfinished-tool-call"
  | "workspace-unavailable";

export interface AutoResumeCandidate {
  task: Task;
  saved: SavedRun;
}

/**
 * The isolated workspace a task run lives in.
 *
 * Mirrors `ensureTaskWorkspace` without the side effect: a task that already has
 * a recorded workspace keeps it, otherwise the run will create
 * `<base>/.loam-tasks/<taskId>` and record exactly that path. `runTask` resolves
 * the same value when the resume actually starts, so a mismatch here means the
 * saved run belonged to a different (legacy) workspace layout.
 */
function expectedTaskWorkspace(task: Task, baseWorkspace: string): string {
  if (task.workspace) return path.resolve(task.workspace);
  return path.resolve(baseWorkspace, ".loam-tasks", task.id);
}

/**
 * Decide whether `saved` may continue without review.
 *
 * Kept pure apart from the workspace existence check, so the rule is
 * unit-testable and reusable. `baseWorkspace` is the caller's current workspace
 * root: a saved run whose workspace no longer exists, or which lived in a
 * legacy shared workspace, cannot be continued safely.
 */
export function canAutoResume(saved: SavedRun, task: Task, baseWorkspace: string): { ok: true } | { ok: false; reason: AutoResumeSkipReason } {
  if (!saved.checkpoint) return { ok: false, reason: "no-checkpoint" };
  if (!saved.checkpoint.logSessionId) return { ok: false, reason: "no-log-evidence" };
  // The log is the authority for "newest state", so it is read explicitly: the
  // `SavedRun` checkpoint is a mutable JSON row, while the append-only log cannot
  // be rewritten. Reading the log is what makes "the latest checkpoint has
  // `inFlight === false`" true rather than merely claimed.
  const logged = readLatestCheckpoint(saved.checkpoint.logSessionId);
  if (!logged) return { ok: false, reason: "no-log-evidence" };
  if (logged.cp.inFlight) return { ok: false, reason: "in-flight" };
  if (saved.checkpoint.inFlight) return { ok: false, reason: "in-flight" };
  // The same rule the UI resume gate applies.
  if (requiresReplayConfirmation(saved)) return { ok: false, reason: "unfinished-tool-call" };
  if (!fs.existsSync(saved.workspace)) return { ok: false, reason: "workspace-unavailable" };
  if (path.resolve(saved.workspace).toLowerCase() !== expectedTaskWorkspace(task, baseWorkspace).toLowerCase()) {
    return { ok: false, reason: "workspace-unavailable" };
  }
  return { ok: true };
}

/**
 * Every interrupted task that may continue without review.
 *
 * Read-only: this only inspects state and never creates a task workspace, so it
 * is safe to call before deciding whether to dispatch anything.
 */
export function findAutoResumableTasks(baseWorkspace: string): AutoResumeCandidate[] {
  const found: AutoResumeCandidate[] = [];
  for (const task of listTasks()) {
    if (task.status !== "interrupted") continue;
    const saved = getSavedRun(task.id);
    if (!saved) continue;
    if (!canAutoResume(saved, task, baseWorkspace).ok) continue;
    found.push({ task, saved });
  }
  return found;
}

/** The subset of `runTask` options an auto-resume dispatch needs. */
export interface AutoResumeRunOptions {
  taskId: string;
  prompt: string;
  resume: true;
  emit: Emit;
}

/**
 * O6b: resume every interrupted task whose latest checkpoint is idle.
 *
 * `runTask` is injected so this module stays free of the `src/index.ts` import
 * cycle (`index -> autoResume -> index`). The dispatch mirrors what the HTTP
 * `/resume` route does, but deliberately leaves `retryInterruptedStep` unset:
 * the safety decision was already made here by reading the durable log, so the
 * run must re-pass `runTask`'s own replay gate at enqueue time. A checkpoint
 * that became unsafe in between therefore stays `interrupted` instead of
 * silently re-running a side-effecting tool.
 *
 * Returns how many tasks were dispatched. A task already in the execution queue is
 * skipped (a route resumed it first), and a failure to enqueue one task is logged
 * and never stops the others. The count is therefore the number actually handed to
 * `runTask`, not the number found eligible: the boot log must not claim a run was
 * continued when it was not.
 */
export function autoResumeInterruptedTasks(
  baseWorkspace: string,
  runTask: (opts: AutoResumeRunOptions) => Promise<unknown>,
): number {
  const candidates = findAutoResumableTasks(baseWorkspace);
  let dispatched = 0;
  for (const { task, saved } of candidates) {
    // The queue is empty at boot, but a resume triggered from a route before
    // this ran must not double-queue the same task.
    if (executionQueue.has(task.id)) continue;
    log.info(`auto-resume (O6b): continuing ${task.id} at checkpoint step ${saved.checkpoint?.nextStep ?? 0}`);
    dispatched += 1;
    void runTask({ taskId: task.id, prompt: saved.prompt, resume: true, emit: () => {} })
      .catch((error) => log.warn(`auto-resume ${task.id}: ${String(error)}`));
  }
  return dispatched;
}
