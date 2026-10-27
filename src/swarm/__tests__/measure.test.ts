import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateThresholds, evaluateLocalStage, median, type MeasureSample } from "../measure.js";

const S = (arm: MeasureSample["arm"], size: MeasureSample["size"], tokens: number, wallMs: number, status = "completed", productWorks = true): MeasureSample =>
  ({ task: "t", size, arm, round: 1, status, tokens, modelMs: wallMs, wallMs, modelCalls: 1, productWorks });

test("median", () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 3); assert.equal(median([]), 0); });

test("the recorded compare result fails the small-task thresholds", () => {
  // swarm-compare.json (2026-10-19 01:04 Riyadh): swarm 1/2 completed, ~1.2M tokens, ~785 s; solo 2/2, ~33.6K, ~26 s.
  const r = evaluateThresholds([S("auto", "small", 664135, 601794, "failed", false), S("auto", "small", 1741423, 967544), S("solo", "small", 33561, 26088), S("solo", "small", 33561, 26088)]);
  assert.equal(r.pass, false);
  assert.ok(r.checks.filter(c => !c.pass).length >= 3);
});

test("routing small briefs to solo passes", () => {
  const r = evaluateThresholds([S("auto", "small", 34000, 27000), S("solo", "small", 33561, 26088), S("auto", "medium", 400000, 300000), S("swarm", "medium", 420000, 320000)]);
  assert.ok(r.pass, JSON.stringify(r.checks));
});

test("medium/large regressions fail", () => {
  const r = evaluateThresholds([S("auto", "large", 600000, 1, "failed", false), S("swarm", "large", 500000, 1)]);
  assert.equal(r.pass, false);
  assert.equal(evaluateThresholds([]).pass, false);
});

test("local-model stage gate", () => {
  const cloud = { runs: 9, completed: 9, gateFailures: 1, medianStageMs: 20000 };
  assert.equal(evaluateLocalStage(cloud, { runs: 9, completed: 9, gateFailures: 1, medianStageMs: 35000 }).pass, true);
  assert.equal(evaluateLocalStage(cloud, { runs: 9, completed: 8, gateFailures: 1, medianStageMs: 20000 }).pass, false);
  assert.equal(evaluateLocalStage(cloud, { runs: 9, completed: 9, gateFailures: 3, medianStageMs: 20000 }).pass, false);
  assert.equal(evaluateLocalStage(cloud, { runs: 5, completed: 5, gateFailures: 0, medianStageMs: 1 }).pass, false);
});
