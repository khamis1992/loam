/**
 * Tests for the recorded baseline and its regression guard (N20).
 *
 * The baseline is the contract's "recorded before N4 merges" requirement. The
 * guard is what makes the record mean something: a later merge that drops a case
 * or lets a score slide has to fail the gate rather than inherit a lower bar.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareBaseline } from "../../scripts/eval-neo.js";
import { NEO_HARNESS_VERSION, NEO_PASS_BAR, type NeoBaseline, type NeoSuiteResult } from "../types.js";

function case_(id: string, total: number, verdict: "pass" | "fail" = "pass") {
  return {
    id,
    dimension: "completion" as const,
    completion: total,
    citation: null,
    flatness: null,
    recovery: null,
    recurring: null,
    total,
    verdict,
    dimensions: [],
    checks: [],
    steps: 1,
    finalText: "",
    durationMs: 0,
  };
}

function suite(cases: ReturnType<typeof case_>[]): NeoSuiteResult {
  return {
    version: NEO_HARNESS_VERSION,
    passBar: NEO_PASS_BAR,
    cases,
    total: Math.round((cases.reduce((sum, c) => sum + c.total, 0) / cases.length) * 100) / 100,
    passed: cases.filter((c) => c.verdict === "pass").length,
    failed: cases.filter((c) => c.verdict !== "pass").length,
    verdict: cases.every((c) => c.verdict === "pass") ? "pass" : "fail",
  };
}

function baselineFor(cases: ReturnType<typeof case_>[]): NeoBaseline {
  return {
    version: NEO_HARNESS_VERSION,
    passBar: NEO_PASS_BAR,
    total: 100,
    passed: cases.length,
    failed: 0,
    cases: cases.map((c) => ({
      id: c.id,
      total: c.total,
      verdict: c.verdict,
      completion: c.completion,
      citation: null,
      flatness: null,
      recovery: null,
      recurring: null,
      steps: c.steps,
      dimensions: [],
    })),
  };
}

describe("compareBaseline", () => {
  it("passes an identical run", () => {
    const cases = [case_("a", 100), case_("b", 100)];
    const result = compareBaseline(suite(cases), baselineFor(cases));
    assert.equal(result.ok, true);
    assert.deepEqual(result.reasons, []);
  });

  it("tolerates arithmetic wobble within the tolerance", () => {
    const recorded = baselineFor([case_("a", 100), case_("b", 100)]);
    const result = compareBaseline(suite([case_("a", 99.5), case_("b", 99.4)]), recorded);
    assert.equal(result.ok, true, `unexpected reasons: ${result.reasons.join("; ")}`);
  });

  it("fails a case that dropped past the baseline", () => {
    const recorded = baselineFor([case_("a", 100), case_("b", 100)]);
    const result = compareBaseline(suite([case_("a", 100), case_("b", 80)]), recorded);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /b regressed \d+(\.\d+)? point\(s\) below its baseline/);
  });

  it("fails a case that fell below the pass bar", () => {
    const recorded = baselineFor([case_("a", 100)]);
    const result = compareBaseline(suite([case_("a", 40, "fail")]), recorded);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /below the bar/);
  });

  it("fails a baseline case missing from the run", () => {
    const recorded = baselineFor([case_("a", 100), case_("b", 100)]);
    const result = compareBaseline(suite([case_("a", 100)]), recorded);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /b is missing from this run/);
  });

  it("fails a suite that stopped clearing its own bar", () => {
    const recorded = baselineFor([case_("a", 100)]);
    const result = compareBaseline(suite([case_("a", 100), case_("b", 50, "fail")]), recorded);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /did not clear its pass bar/);
  });

  it("skips the comparison when no baseline is recorded", () => {
    const result = compareBaseline(suite([case_("a", 100)]), undefined);
    assert.equal(result.ok, true);
  });

  it("does not compare a baseline from another harness version", () => {
    const recorded = { ...baselineFor([case_("a", 100)]), version: "neo-eval-1" };
    const result = compareBaseline(suite([case_("a", 1)]), recorded);
    assert.equal(result.ok, true);
    assert.match(result.reasons.join("; "), /not compared/);
  });

  it("reports the suite version and bar on every run", () => {
    const result = suite([case_("a", 100)]);
    assert.equal(result.version, NEO_HARNESS_VERSION);
    assert.equal(result.passBar, NEO_PASS_BAR);
  });
});
