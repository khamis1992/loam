import { strict as assert } from "node:assert";
import { test } from "node:test";
import { score, gatesHold } from "../bench/score.js";

const rows = [
  { id: "1", expected: "vulnerable" as const, actual: "finding" as const, cwe: "79" },
  { id: "2", expected: "vulnerable" as const, actual: "finding" as const, cwe: "89" },
  { id: "4", expected: "benign" as const, actual: "clean" as const, fpTrap: true },
  { id: "5", expected: "benign" as const, actual: "clean" as const, fpTrap: true },
  { id: "6", expected: "benign" as const, actual: "finding" as const },
  { id: "7", expected: "vulnerable" as const, actual: "finding" as const, cwe: "79" },
  { id: "8", expected: "benign" as const, actual: "finding" as const },
];

test("uniform scorer computes the full metric family", () => {
  const s = score("fixture", rows);
  assert.equal(s.cases, 7);
  assert.deepEqual([s.tp, s.fp, s.fn, s.tn], [3, 2, 0, 2]);
  assert.equal(s.recall, 1);
  assert.equal(s.tpr, 1);
  assert.equal(s.fpr, 0.5);
  assert.equal(s.youdenJ, 0.5);
  assert.equal(s.fpTrapPassRate, 1);
  assert.deepEqual(s.perCwe?.["89"], { tp: 1, fp: 0, fn: 0 });
  // F2 weights recall over precision
  assert.ok(s.f2 > s.f1);
});

test("upgrade gate blocks regressions and allows ties", () => {
  const base = score("d", rows);
  const better = score("d", [...rows, { id: "3b", expected: "vulnerable", actual: "finding", cwe: "89" }]);
  assert.equal(gatesHold(better, base).ok, true);
  const worse = score("d", rows.map((r) => (r.id === "1" ? { ...r, actual: "clean" as const } : r)));
  const g = gatesHold(worse, base);
  assert.equal(g.ok, false);
  assert.ok(g.regressions.some((x) => x.startsWith("recall")));
  const trapFail = score("d", rows.map((r) => (r.id === "4" ? { ...r, actual: "finding" as const } : r)));
  assert.ok(!gatesHold(trapFail, base).ok, "FP-trap regression blocks the gate");
  assert.equal(gatesHold(base, base).ok, true, "a tie holds");
});
