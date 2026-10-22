/**
 * Neo N1: run-node lifecycle.
 *
 * A node moves forward through the graph. Terminal states (`finished`, `failed`,
 * `skipped`) are absorbing, so a late replayed event can never reopen a node the
 * canvas already rendered as done. `setStatus` is the only way to change status,
 * which keeps the rule enforced everywhere (adapter, canvas edits, tests).
 */
import type { RunNodeStatus } from "./store.js";

/**
 * Allowed transitions. `init` may go anywhere because a plan can be abandoned
 * before it starts; `running` may finish, fail, or be skipped; terminal states
 * are absorbing.
 */
const TRANSITIONS: Record<RunNodeStatus, readonly RunNodeStatus[]> = {
  init: ["running", "finished", "failed", "skipped"],
  running: ["finished", "failed", "skipped"],
  finished: ["finished"],
  failed: ["failed"],
  skipped: ["skipped"],
};

export function nextStatuses(status: RunNodeStatus): readonly RunNodeStatus[] {
  return TRANSITIONS[status] ?? [];
}

export function canTransition(from: RunNodeStatus, to: RunNodeStatus): boolean {
  return nextStatuses(from).includes(to);
}

/** Throw on an illegal transition; returns the target status when it is legal. */
export function assertTransition(from: RunNodeStatus, to: RunNodeStatus): RunNodeStatus {
  if (!canTransition(from, to)) {
    throw new Error(`illegal run node transition: ${from} -> ${to}`);
  }
  return to;
}
