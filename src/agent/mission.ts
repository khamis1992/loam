/**
 * Neo N6: unbounded "mission" runs.
 *
 * A mission is a run type with no fixed step cap. Instead of `maxSteps = 40`,
 * a mission is bounded by a *budget* — steps, tokens, wall-clock and cost — and
 * by durable checkpoints written after every step, so a server restart resumes
 * the mission at its last safe boundary instead of losing the whole run.
 *
 * This module owns the pieces that are pure or persistence-only and therefore
 * testable without a model:
 *
 * - `MissionBudget` (a `ComputeBudget` plus its limits), built from config;
 * - the durable checkpoint record and its read/write seam over the existing
 *   `entities` store (the same table the run graph uses);
 * - the resume decision: is the checkpoint fresh enough to resume from, or does
 *   it describe work that is still in flight (which needs explicit confirmation)?
 *
 * The run itself still goes through `runAgent`/`runOrchestratedAgent`; a mission
 * is those paths with `mission: true`, which lifts the step cap and consults the
 * extended budget before every step.
 */
import { createComputeBudget, type ComputeBudget, type ComputeBudgetLimits } from "./computeBudget.js";
import { getEntity, putEntity, removeEntity } from "../server/sqliteStore.js";

/** Limits of a mission run, expressed in the units the user can reason about. */
export interface MissionLimits {
  /** Step ceiling; omitted or 0 means unbounded steps. */
  steps?: number;
  /** Token ceiling. */
  tokens?: number;
  /** Wall-clock ceiling in minutes (config-facing unit). */
  minutes?: number;
  /** Cost ceiling in USD. */
  costUsd?: number;
}

/** Minutes → milliseconds; undefined stays undefined so the dimension is off. */
export function minutesToMs(minutes: number | undefined): number | undefined {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.floor(minutes * 60_000);
}

/** Build the budget a mission runs under. No limits = truly unbounded. */
export function createMissionBudget(limits: MissionLimits = {}): ComputeBudget {
  return createComputeBudget({
    stepLimit: limits.steps,
    tokenLimit: limits.tokens,
    wallClockMs: minutesToMs(limits.minutes),
    costUsd: limits.costUsd,
  });
}

/**
 * The budget a mission run starts with: the configured ceilings, plus the
 * counters a resumed checkpoint already charged.
 *
 * A resume must not restart the clock or the spend. The ceiling is rebuilt from
 * config (so a raise the user made while the mission was stopped takes effect),
 * while the counters come from the checkpoint, so a mission that already burned
 * 40 minutes of a 60-minute ceiling has 20 left rather than a fresh hour.
 *
 * `carried` is optional: a first run has no checkpoint and starts at zero.
 */
export function missionBudgetFrom(limits: MissionLimits | undefined, carried?: ComputeBudget): ComputeBudget {
  const budget = createMissionBudget(limits);
  if (!carried) return budget;
  budget.steps = carried.steps;
  budget.promptTokens = carried.promptTokens;
  budget.completionTokens = carried.completionTokens;
  budget.wallClockMs = carried.wallClockMs;
  budget.costUsd = carried.costUsd;
  budget.raised = carried.raised;
  return budget;
}

/** The limits of a budget, in the units a user configures them with. */
export function missionLimitsOf(budget: ComputeBudget): MissionLimits {
  return {
    steps: budget.stepLimit,
    tokens: budget.tokenLimit,
    minutes: budget.wallClockLimitMs === undefined ? undefined : budget.wallClockLimitMs / 60_000,
    costUsd: budget.costLimitUsd,
  };
}

/** True when the mission has no ceiling at all in any dimension. */
export function isUnbounded(budget: ComputeBudget): boolean {
  const limits: ComputeBudgetLimits = missionLimitsOf(budget);
  return limits.stepLimit === undefined && limits.tokenLimit === undefined &&
    limits.wallClockMs === undefined && limits.costUsd === undefined;
}

/**
 * Why a mission ended. `budget` is the only stop that is *not* a failure: the
 * run reached the ceiling the user set, so the summary node reports the budget
 * rather than an error.
 */
export type MissionEndReason = "completed" | "budget" | "cancelled" | "failed";

/** One durable checkpoint of a mission, written after every completed step. */
export interface MissionCheckpoint {
  version: 1;
  /** Owning task id (== run id). */
  taskId: string;
  /** The prompt the mission is still working on. */
  prompt: string;
  /** Index of the last completed step; the resume continues at `lastStep + 1`. */
  lastStep: number;
  /** Budget counters as of this checkpoint, so a resume never restarts the clock. */
  budget: ComputeBudget;
  /** When the checkpoint was written (ISO). */
  checkpointedAt: string;
  /** Set while a step is executing: a resume from this point is not automatic. */
  inFlight?: boolean;
  /** The reason the mission last stopped, when it did. */
  endedReason?: MissionEndReason;
  /** Short human summary of where the mission got to. */
  summary?: string;
}

export const MISSION_CHECKPOINT_ENTITY = "mission_checkpoint";

/**
 * Persistence seam. The default implementation is the existing `entities`
 * store, so a mission checkpoint survives a server restart and is readable by a
 * fresh process. Tests inject a memory store.
 */
export interface MissionCheckpointStore {
  save(checkpoint: MissionCheckpoint): void;
  load(taskId: string): MissionCheckpoint | undefined;
  clear(taskId: string): void;
}

/** In-memory store, used by tests and as a fallback. */
export class MemoryMissionCheckpointStore implements MissionCheckpointStore {
  private readonly records = new Map<string, MissionCheckpoint>();
  save(checkpoint: MissionCheckpoint): void {
    this.records.set(checkpoint.taskId, structuredClone(checkpoint));
  }
  load(taskId: string): MissionCheckpoint | undefined {
    const found = this.records.get(taskId);
    return found ? structuredClone(found) : undefined;
  }
  clear(taskId: string): void {
    this.records.delete(taskId);
  }
}

/** Store backed by the app database (`entities` family). */
export class DbMissionCheckpointStore implements MissionCheckpointStore {
  save(checkpoint: MissionCheckpoint): void {
    // The `entities` table keys a row by `id`, so the payload needs one. It is
    // derived from `taskId` and dropped again on read: a caller must get back
    // exactly the checkpoint it saved, or a comparison of the two (the resume
    // path compares counters) would see a field the caller never set.
    putEntity(MISSION_CHECKPOINT_ENTITY, { ...checkpoint, id: checkpoint.taskId });
  }
  load(taskId: string): MissionCheckpoint | undefined {
    const row = getEntity<MissionCheckpoint & { id?: string }>(MISSION_CHECKPOINT_ENTITY, taskId);
    if (!row) return undefined;
    const { id: _rowKey, ...record } = row;
    return record;
  }
  clear(taskId: string): void {
    removeEntity(MISSION_CHECKPOINT_ENTITY, taskId);
  }
}

export const missionCheckpoints = new DbMissionCheckpointStore();

/**
 * True when a stored checkpoint can be resumed automatically.
 *
 * A checkpoint taken *between* steps is a safe boundary and resumes without
 * asking. A checkpoint taken while a step was executing means an effect may be
 * half-applied, so the caller must confirm the replay before continuing.
 */
export function resumableFrom(checkpoint: MissionCheckpoint | undefined): boolean {
  if (!checkpoint) return false;
  if (checkpoint.inFlight) return false;
  if (checkpoint.endedReason && checkpoint.endedReason !== "cancelled") return false;
  return true;
}

/**
 * Neo N6: resumability of a *mission* checkpoint.
 *
 * A mission can also stop on its budget, which is a clean end (not a failure),
 * and that boundary is exactly what a resume after a raise continues from. The
 * ordinary predicate above refuses any ended reason other than cancellation, so
 * it would make a budget stop unresumable. What stays non-resumable is the same
 * in both: a checkpoint written while a step was executing, and a mission that
 * ended because it completed or failed.
 */
export function missionResumableFrom(checkpoint: MissionCheckpoint | undefined): boolean {
  if (!checkpoint) return false;
  if (checkpoint.inFlight) return false;
  return checkpoint.endedReason !== "completed" && checkpoint.endedReason !== "failed";
}

/** The step index a resume continues at (the first step not yet done). */
export function resumeStep(checkpoint: MissionCheckpoint): number {
  return checkpoint.lastStep + 1;
}

/**
 * True when a saved run may be resumed even though its task is already closed.
 *
 * A budget stop ends a mission *cleanly* (it reached the ceiling the user set),
 * but the mission is not finished: the user raises the budget and continues from
 * the same checkpoint. The normal resume gate refuses a `done` task because a
 * completed run has nothing left to resume; this is the one exception, and the
 * `budget` reason is what guarantees the checkpoint was written between steps
 * (a stop recorded while a step was executing would not be resumable).
 */
export function canResumeMission(
  run: { mission?: boolean; missionCheckpoint?: MissionCheckpoint } | undefined,
): boolean {
  if (!run || run.mission !== true) return false;
  const checkpoint = run.missionCheckpoint;
  if (!checkpoint) return false;
  return checkpoint.endedReason === "budget" && missionResumableFrom(checkpoint);
}

/**
 * Checkpoint for a mission stopped by its budget, at `lastStep` (the last step
 * that completed). Shared by the loop and the run adapter so the record is
 * written exactly one way.
 */
export function budgetStoppedCheckpoint(
  input: { taskId?: string; prompt: string; lastStep: number; budget: ComputeBudget; summary?: string },
): MissionCheckpoint {
  return {
    version: 1,
    taskId: input.taskId ?? "",
    prompt: input.prompt,
    lastStep: input.lastStep,
    budget: { ...input.budget },
    checkpointedAt: new Date().toISOString(),
    endedReason: "budget",
    ...(input.summary ? { summary: input.summary } : {}),
  };
}

/**
 * Build the summary node payload a budget stop emits. The mission ends *cleanly*:
 * the canvas shows where it got to and what it consumed, not an error banner.
 */
export function budgetSummary(checkpoint: MissionCheckpoint, reason: string): string {
  const budget = checkpoint.budget;
  const parts = [
    `Mission stopped at step ${checkpoint.lastStep} of the mission budget.`,
    `Consumed ${budget.steps} steps, ${budget.promptTokens + budget.completionTokens} tokens` +
      // The counters always exist (a fresh budget zeroes them), so the limit is
      // what says whether the mission was bounded by that dimension at all.
      // Testing the counter would report "0m wall-clock, $0.0000" for a mission
      // that never had a clock or a cost ceiling.
      (budget.wallClockLimitMs !== undefined ? `, ${Math.round((budget.wallClockMs ?? 0) / 60_000)}m wall-clock` : "") +
      (budget.costLimitUsd !== undefined ? `, $${(budget.costUsd ?? 0).toFixed(4)}` : "") + ".",
    reason,
  ];
  if (checkpoint.summary) parts.push(checkpoint.summary);
  return parts.join(" ");
}
