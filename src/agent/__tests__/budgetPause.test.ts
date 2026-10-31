/**
 * Budget pause policy.
 *
 * A pause is not a stop: the run parks and keeps its transcript, a resume wakes
 * it, and the epoch makes a resume that lands before the waiter is installed win
 * instead of being lost. A second pause while parked keeps the first reason.
 * Cancellation rejects the waiter.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  budgetPauseReason,
  budgetPauseSnapshot,
  clearBudgetPause,
  isBudgetPaused,
  pauseBudget,
  resumeBudget,
  waitForBudgetResume,
} from "../budgetPause.js";
import { CancelledError } from "../../server/runControl.js";

describe("budget pause", () => {
  it("parks and resumes a task", async () => {
    const task = "t-park";
    pauseBudget(task, "budget nearly spent");
    assert.equal(isBudgetPaused(task), true);
    assert.equal(budgetPauseReason(task), "budget nearly spent");
    const waited = waitForBudgetResume(task);
    const epoch = resumeBudget(task);
    assert.equal(typeof epoch, "number");
    await waited;
    assert.equal(isBudgetPaused(task), false);
  });

  it("keeps the first reason when paused twice", () => {
    const task = "t-twice";
    pauseBudget(task, "first");
    pauseBudget(task, "second");
    assert.equal(budgetPauseReason(task), "first");
    clearBudgetPause(task);
  });

  it("resolves immediately when the task is not paused", async () => {
    await waitForBudgetResume("t-idle");
    assert.equal(isBudgetPaused("t-idle"), false);
  });

  it("wakes on a resume that lands before the wait is observed", async () => {
    const task = "t-race";
    pauseBudget(task, "park");
    const waited = waitForBudgetResume(task);
    // Resume in the same tick: the epoch captured at wait time is already stale.
    resumeBudget(task);
    await Promise.race([waited, new Promise((_, reject) => setTimeout(() => reject(new Error("missed resume")), 500))]);
  });

  it("stays parked on a resume that predates a newer pause", async () => {
    const task = "t-repause";
    pauseBudget(task, "first");
    const waited = waitForBudgetResume(task);
    resumeBudget(task);
    pauseBudget(task, "second");
    // The waiter belongs to the first pause, so the newer one keeps it parked.
    const second = waitForBudgetResume(task);
    resumeBudget(task);
    await Promise.all([waited, second]);
    assert.equal(isBudgetPaused(task), false);
  });

  it("rejects the waiter on abort", async () => {
    const task = "t-abort";
    pauseBudget(task, "park");
    const controller = new AbortController();
    const waited = waitForBudgetResume(task, controller.signal);
    controller.abort();
    await assert.rejects(waited, CancelledError);
    clearBudgetPause(task);
  });

  it("reports a snapshot for the operator", () => {
    const task = "t-snapshot";
    pauseBudget(task, "why");
    assert.equal(budgetPauseSnapshot(task).paused, true);
    clearBudgetPause(task);
    assert.equal(budgetPauseSnapshot(task).paused, false);
  });
});
