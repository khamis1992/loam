import assert from "node:assert";
import { describe, it } from "node:test";

import {
  WARN_RATIO,
  checkBudget,
  consumeSteps,
  consumeTokens,
  createComputeBudget,
  createUnlimitedBudget,
  formatBudgetUsage,
  normalizeLimit,
  raiseBudget,
  resetBudgetUsage,
  totalTokens,
} from "../computeBudget.js";

describe("compute budget limits", () => {
  it("treats only positive finite numbers as limits", () => {
    assert.equal(normalizeLimit(10), 10);
    assert.equal(normalizeLimit(10.9), 10);
    assert.equal(normalizeLimit(0), undefined);
    assert.equal(normalizeLimit(-5), undefined);
    assert.equal(normalizeLimit(NaN), undefined);
    assert.equal(normalizeLimit(Infinity), undefined);
    assert.equal(normalizeLimit("10"), undefined);
    assert.equal(normalizeLimit(undefined), undefined);
  });

  it("creates a budget with no limits by default", () => {
    const budget = createComputeBudget();
    assert.equal(budget.steps, 0);
    assert.equal(totalTokens(budget), 0);
    assert.equal(budget.stepLimit, undefined);
    assert.equal(budget.tokenLimit, undefined);
    assert.equal(checkBudget(budget).action, "allow");
  });

  it("accumulates steps and tokens, ignoring garbage input", () => {
    const budget = createUnlimitedBudget();
    assert.equal(consumeSteps(budget, 3), 3);
    assert.equal(consumeSteps(budget, -1), 3);
    assert.equal(consumeSteps(budget, Number.NaN), 3);
    consumeTokens(budget, 100, 20);
    consumeTokens(budget, Number.NaN, -5);
    assert.equal(totalTokens(budget), 120);
    assert.equal(budget.promptTokens, 100);
    assert.equal(budget.completionTokens, 20);
  });
});

describe("compute budget verdicts", () => {
  it("allows work well below the ceiling", () => {
    const budget = createComputeBudget({ stepLimit: 10, tokenLimit: 1000 });
    consumeSteps(budget, 4);
    consumeTokens(budget, 400, 0);
    assert.deepEqual(checkBudget(budget), { action: "allow" });
  });

  it("warns at 80% of the step budget", () => {
    assert.equal(WARN_RATIO, 0.8);
    const budget = createComputeBudget({ stepLimit: 10 });
    consumeSteps(budget, 7);
    assert.equal(checkBudget(budget).action, "allow");
    consumeSteps(budget, 1);
    const decision = checkBudget(budget);
    assert.equal(decision.action, "warn");
    assert.match((decision as { reason: string }).reason, /80%/);
  });

  it("warns at 80% of the token budget", () => {
    const budget = createComputeBudget({ tokenLimit: 1000 });
    consumeTokens(budget, 800, 0);
    assert.equal(checkBudget(budget).action, "warn");
    consumeTokens(budget, 0, 1);
    assert.equal(checkBudget(budget).action, "warn");
  });

  it("stops at 100% and reports the exhausted dimension", () => {
    const budget = createComputeBudget({ stepLimit: 4, tokenLimit: 100 });
    consumeSteps(budget, 4);
    consumeTokens(budget, 10, 0);
    const decision = checkBudget(budget);
    assert.equal(decision.action, "stop");
    assert.match((decision as { reason: string }).reason, /4\/4 steps/);
  });

  it("stops on the token ceiling too, and the stop wins over a warning", () => {
    const budget = createComputeBudget({ stepLimit: 100, tokenLimit: 50 });
    consumeSteps(budget, 5); // 5% of steps — well under the warning
    consumeTokens(budget, 50, 0); // 100% of tokens
    const decision = checkBudget(budget);
    assert.equal(decision.action, "stop");
    assert.match((decision as { reason: string }).reason, /50\/50 tokens/);
  });

  it("falls back to the caller-supplied limits when the budget carries none", () => {
    const budget = createComputeBudget();
    consumeSteps(budget, 8);
    assert.equal(checkBudget(budget, { stepLimit: 10 }).action, "warn");
    consumeSteps(budget, 2);
    assert.equal(checkBudget(budget, { stepLimit: 10 }).action, "stop");
    // Without a fallback limit the session is unlimited.
    assert.equal(checkBudget(budget).action, "allow");
  });

  it("a per-budget limit overrides the caller-supplied one", () => {
    const budget = createComputeBudget({ stepLimit: 100 });
    consumeSteps(budget, 50);
    // The caller asks for a 10-step limit; the session's own 100 wins.
    assert.equal(checkBudget(budget, { stepLimit: 10 }).action, "allow");
  });

  it("formats usage for the UI", () => {
    const budget = createComputeBudget({ stepLimit: 10, tokenLimit: 1000 });
    consumeSteps(budget, 8);
    consumeTokens(budget, 100, 50);
    assert.equal(formatBudgetUsage(budget), "steps 8/10 · tokens 150/1000");
    const open = createComputeBudget();
    assert.equal(formatBudgetUsage(open), "steps 0 · tokens 0");
  });
});

describe("compute budget raise", () => {
  it("refuses a non-positive increase", () => {
    const budget = createComputeBudget({ stepLimit: 10 });
    assert.equal(raiseBudget(budget, { steps: 0 }).ok, false);
    assert.equal(raiseBudget(budget, { steps: -5 }).ok, false);
    assert.equal(raiseBudget(budget, {}).ok, false);
    assert.equal(budget.stepLimit, 10);
    assert.equal(budget.raised, undefined);
  });

  it("raises the step ceiling and lets the session continue", () => {
    const budget = createComputeBudget({ stepLimit: 4 });
    consumeSteps(budget, 4);
    assert.equal(checkBudget(budget).action, "stop");

    assert.equal(raiseBudget(budget, { steps: 4 }).ok, true);
    assert.equal(budget.stepLimit, 8);
    assert.equal(budget.raised, true);
    // Counters are not reset: 4 steps already spent.
    assert.equal(budget.steps, 4);
    assert.equal(checkBudget(budget).action, "allow");

    consumeSteps(budget, 4);
    assert.equal(checkBudget(budget).action, "stop");
  });

  it("raises the token ceiling relative to usage", () => {
    const budget = createComputeBudget({ tokenLimit: 100 });
    consumeTokens(budget, 100, 0);
    assert.equal(checkBudget(budget).action, "stop");
    assert.equal(raiseBudget(budget, { tokens: 200 }).ok, true);
    assert.equal(budget.tokenLimit, 300);
    // Usage is kept: 100/300 = 33%, which is still below the 80% warning.
    assert.equal(checkBudget(budget).action, "allow");
  });

  it("keeps usage when resetting counters, only clearing the tallies", () => {
    const budget = createComputeBudget({ stepLimit: 10, tokenLimit: 1000 });
    consumeSteps(budget, 9);
    consumeTokens(budget, 900, 0);
    resetBudgetUsage(budget);
    assert.equal(budget.steps, 0);
    assert.equal(totalTokens(budget), 0);
    assert.equal(budget.stepLimit, 10);
    assert.equal(budget.tokenLimit, 1000);
    assert.equal(checkBudget(budget).action, "allow");
  });
});
