/**
 * Virtual clock for the recurring-work fixtures.
 *
 * A long-horizon eval cannot wait a real week, and a real scheduler would make
 * the gate flaky. Instead the harness owns a {@link MockClock} and asks the
 * schedule layer when the next occurrence is due; the fixture author drives the
 * clock forward explicitly and asserts what the agent did in each round.
 *
 * The clock never touches `Date.now()` internally, so the pure scheduling math
 * in `src/server/scheduleTime.ts` can be exercised with it without patching
 * globals. `src/server/scheduleTime.ts` stays the single source of truth for
 * cron/timezone semantics.
 */
import { initialNextRunAt, nextOccurrenceAfter, type ScheduleTiming } from "../server/scheduleTime.js";

/** A clock that only moves when the harness says so. */
export class MockClock {
  private nowMs: number;

  constructor(startIso: string) {
    const parsed = Date.parse(startIso);
    if (!Number.isFinite(parsed)) throw new Error(`MockClock: invalid start time ${startIso}`);
    this.nowMs = parsed;
  }

  /** Current instant. */
  now(): Date {
    return new Date(this.nowMs);
  }

  /** Current instant as an ISO string. */
  iso(): string {
    return new Date(this.nowMs).toISOString();
  }

  /** Advance to an absolute instant (no-op when it is not in the future). */
  advanceTo(iso: string): void {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new Error(`MockClock: invalid time ${iso}`);
    if (ms > this.nowMs) this.nowMs = ms;
  }

  /** Advance by a number of milliseconds. */
  advance(ms: number): void {
    if (ms < 0) throw new Error("MockClock cannot move backwards");
    this.nowMs += ms;
  }

  /** Advance to the next occurrence of `timing` strictly after now. */
  advanceToNext(timing: ScheduleTiming): string | null {
    const next = nextOccurrenceAfter(timing, this.now());
    if (next === null) return null;
    this.advanceTo(next);
    return next;
  }
}

/** Compute the first due instant for a schedule without mutating a clock. */
export function firstDueAt(timing: ScheduleTiming, from: Date): string {
  return initialNextRunAt(timing, from);
}

/** How many occurrences of `timing` fall at or before `deadlineIso`, starting at `startIso`. */
export function countOccurrences(timing: ScheduleTiming, startIso: string, deadlineIso: string): number {
  const deadline = Date.parse(deadlineIso);
  const clock = new MockClock(startIso);
  let count = 0;
  for (let i = 0; i < 64; i++) {
    const next = clock.advanceToNext(timing);
    if (next === null) return count;
    if (Date.parse(next) > deadline) return count;
    count += 1;
  }
  return count;
}
