import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


process.env.LOAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loam-skillab-"));
process.env.MANUS_LOCAL_DATA_DIR = process.env.LOAM_DATA_DIR;

const { analyseAb } = await import("../stats.js");

test("cluster bootstrap math without a live model", () => {
  // Two tasks, skill clearly better on both: HELPS.
  const pairs = [
    { taskId: "t1", trial: 1, baseline: 0, withSkill: 1, baselineTokens: 100, withSkillTokens: 120 },
    { taskId: "t1", trial: 2, baseline: 0, withSkill: 1, baselineTokens: 100, withSkillTokens: 120 },
    { taskId: "t2", trial: 1, baseline: 0, withSkill: 1, baselineTokens: 100, withSkillTokens: 120 },
    { taskId: "t2", trial: 2, baseline: 0, withSkill: 1, baselineTokens: 100, withSkillTokens: 120 },
  ];
  const r = analyseAb(pairs, { iterations: 500, seed: 1337 });
  assert.ok(["HELPS", "INCONCLUSIVE"].includes(r.verdict));
  assert.ok(Number.isFinite(r.effectPp));
  assert.ok(r.ci95[0]! <= r.ci95[1]!);
  // Identical arms: NO_EFFECT or INCONCLUSIVE.
  const flat = pairs.map((p) => ({ ...p, withSkill: p.baseline, withSkillTokens: p.baselineTokens }));
  const r2 = analyseAb(flat, { iterations: 200, seed: 1337 });
  assert.ok(["NO_EFFECT", "INCONCLUSIVE"].includes(r2.verdict));
});

test("low-sample warning", () => {
  const one = [{ taskId: "t1", trial: 1, baseline: 0, withSkill: 1, baselineTokens: 1, withSkillTokens: 1 }];
  const r = analyseAb(one, { iterations: 100, seed: 1 });
  assert.equal(r.lowSample, true);
});
