/**
 * Budget pause policy (Strix `--max-budget` parity).
 *
 * A run has two ways to react to its ceiling:
 *
 *   - `stop`: the loop throws at the boundary (the pre-existing behaviour);
 *   - `pause`: the run parks before its next model call until an operator
 *     resumes it (optionally after raising the ceiling) or cancels it.
 *
 * A pause is *not* a stop: the run keeps its transcript and its checkpoint, so
 * resuming continues from the same step instead of restarting. Both decisions
 * are taken under an epoch so a resume that lands between "we are paused" and
 * "we start waiting" is not lost, and a stop can never be overwritten by a
 * resume.
 */
import { CancelledError } from "../server/runControl.js";

interface PauseState {
  reason: string;
  /** Bumped on every pause; a waiter only wakes on a *later* epoch. */
  epoch: number;
  /** Resolvers of runs currently parked here. */
  waiters: Set<() => void>;
  pausedAt: string;
}

const pauseStates = new Map<string, PauseState>();
const CAPACITY = 512;

function setState(taskId: string, state: PauseState): void {
  if (pauseStates.size >= CAPACITY && !pauseStates.has(taskId)) {
    const oldest = pauseStates.keys().next().value;
    if (oldest !== undefined) pauseStates.delete(oldest);
  }
  pauseStates.set(taskId, state);
}

/** Park the run before its next step. Idempotent: pausing twice keeps the first reason and epoch. */
export function pauseBudget(taskId: string, reason: string, now = new Date().toISOString()): PauseState {
  const existing = pauseStates.get(taskId);
  if (existing) return existing;
  const state: PauseState = { reason, epoch: (pauseStates.get(taskId)?.epoch ?? 0) + 1, waiters: new Set(), pausedAt: now };
  setState(taskId, state);
  return state;
}

/** True when the task is parked on the budget. */
export function isBudgetPaused(taskId: string): boolean {
  return pauseStates.has(taskId);
}

/** Current pause reason, when one is set. */
export function budgetPauseReason(taskId: string): string | undefined {
  return pauseStates.get(taskId)?.reason;
}

/**
 * Release every parked waiter. Returns the epoch that was released (higher than
 * any wait taken before it), or undefined when the task was not paused. A stop
 * that already ended the run is unaffected: resume only wakes waiters.
 */
export function resumeBudget(taskId: string): number | undefined {
  const state = pauseStates.get(taskId);
  if (!state) return undefined;
  pauseStates.delete(taskId);
  for (const wake of state.waiters) wake();
  return state.epoch;
}

/**
 * Wait until the task is resumed (or cancelled). Resolves immediately when the
 * task is not paused. The epoch captured at call time makes a resume that lands
 * in the same tick deterministic: a waiter only clears on a newer epoch than
 * the one it observed.
 */
export function waitForBudgetResume(taskId: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let armed = pauseStates.get(taskId);
    if (!armed) return resolve();
    let seenEpoch = armed.epoch;
    const cleanup = (): void => {
      armed?.waiters.delete(wake);
      signal?.removeEventListener("abort", onAbort);
    };
    const wake = (): void => {
      const next = pauseStates.get(taskId);
      // Resumed, or replaced by a newer pause: either way this waiter is stale.
      if (next && next.epoch === seenEpoch) return;
      if (next) {
        // A newer pause landed between the resume and this callback: follow it
        // instead of resolving, so the run stays parked and is woken next time.
        seenEpoch = next.epoch;
        armed = next;
        next.waiters.add(wake);
        return;
      }
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new CancelledError());
    };
    if (signal?.aborted) return onAbort();
    armed.waiters.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Forget a task's pause state (the run ended). */
export function clearBudgetPause(taskId: string): void {
  pauseStates.delete(taskId);
}

/** Snapshot for the badge / API payload. */
export function budgetPauseSnapshot(taskId: string): { paused: boolean; reason?: string; pausedAt?: string; epoch?: number } {
  const state = pauseStates.get(taskId);
  return state ? { paused: true, reason: state.reason, pausedAt: state.pausedAt, epoch: state.epoch } : { paused: false };
}
