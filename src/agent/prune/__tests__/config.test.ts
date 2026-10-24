import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PRUNE_CONFIG, resolvePruneConfig } from "../config.js";
import { loadConfig } from "../../../config.js";

test("a missing block means summary, with the other defaults intact", () => {
  for (const raw of [undefined, null, "x", [], 7]) {
    const c = resolvePruneConfig(raw, {});
    assert.equal(c.strategy, "summary");
    assert.deepEqual({ ...c, strategy: "x" }, { ...DEFAULT_PRUNE_CONFIG, strategy: "x" });
  }
});

test("an empty block ships the spec defaults (prune_then_summary)", () => {
  assert.deepEqual(resolvePruneConfig({}, {}), DEFAULT_PRUNE_CONFIG);
  assert.equal(DEFAULT_PRUNE_CONFIG.keepThreshold, 0.5);
  assert.equal(DEFAULT_PRUNE_CONFIG.preserveRecent, 6);
  assert.equal(DEFAULT_PRUNE_CONFIG.headChars, 300);
  assert.equal(DEFAULT_PRUNE_CONFIG.minReduction, 0.15);
});

test("values are validated and clamped; invalid ones keep the default", () => {
  const c = resolvePruneConfig({
    strategy: "bogus", scorer: 3, model: "  m1  ", keepThreshold: 5, preserveRecent: -4, headChars: 99999.7,
    minReduction: 2, maxStateTokens: "x", maxRequestTokens: 5, pinnedTools: ["a", " a ", 1, "", "b"], sideEffectTools: "no",
  }, {});
  assert.equal(c.strategy, "prune_then_summary");
  assert.equal(c.scorer, "heuristic");
  assert.equal(c.model, "m1");
  assert.equal(c.keepThreshold, 1);
  assert.equal(c.preserveRecent, 0);
  assert.equal(c.headChars, 5000);
  assert.equal(c.minReduction, 0.9);
  assert.equal(c.maxStateTokens, 12000);
  assert.equal(c.maxRequestTokens, 1000);
  assert.deepEqual(c.pinnedTools, ["a", "b"]);
  assert.deepEqual(c.sideEffectTools, []);
  assert.equal(resolvePruneConfig({ minReduction: -1 }, {}).minReduction, 0);
  assert.equal(resolvePruneConfig({ keepThreshold: NaN }, {}).keepThreshold, 0.5);
});

test("env overrides win, and unknown env values are ignored", () => {
  assert.equal(resolvePruneConfig(undefined, { LOAM_PRUNE_STRATEGY: "prune" }).strategy, "prune");
  assert.equal(resolvePruneConfig({ strategy: "prune" }, { LOAM_PRUNE_STRATEGY: " summary " }).strategy, "summary");
  assert.equal(resolvePruneConfig({ strategy: "prune" }, { LOAM_PRUNE_STRATEGY: "nope" }).strategy, "prune");
  assert.equal(resolvePruneConfig({}, { LOAM_PRUNE_SCORER: "model" }).scorer, "model");
  assert.equal(resolvePruneConfig({}, { LOAM_PRUNE_SCORER: "nope" }).scorer, "heuristic");
});

test("the default array fields are not shared between results", () => {
  const a = resolvePruneConfig({}, {});
  a.pinnedTools.push("x");
  assert.deepEqual(DEFAULT_PRUNE_CONFIG.pinnedTools, []);
});

test("loadConfig: a stale file without the block keeps summary; a file with one is honoured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-prune-cfg-"));
  const saved = { cfg: process.env.LOAM_CONFIG, s: process.env.LOAM_PRUNE_STRATEGY, sc: process.env.LOAM_PRUNE_SCORER };
  delete process.env.LOAM_PRUNE_STRATEGY;
  delete process.env.LOAM_PRUNE_SCORER;
  try {
    const stale = path.join(dir, "stale.json");
    fs.writeFileSync(stale, JSON.stringify({ compression: { enabled: true } }));
    process.env.LOAM_CONFIG = stale;
    assert.equal(loadConfig().compression.prune?.strategy, "summary");

    const withBlock = path.join(dir, "with.json");
    fs.writeFileSync(withBlock, JSON.stringify({ compression: { prune: { strategy: "prune", minReduction: 0.3 } } }));
    process.env.LOAM_CONFIG = withBlock;
    const c = loadConfig().compression;
    assert.equal(c.prune?.strategy, "prune");
    assert.equal(c.prune?.minReduction, 0.3);
    assert.equal(c.thresholdPercent, 0.5);

    process.env.LOAM_CONFIG = path.join(dir, "absent.json");
    assert.equal(loadConfig().compression.prune?.strategy, "summary");
  } finally {
    for (const [k, v] of [["LOAM_CONFIG", saved.cfg], ["LOAM_PRUNE_STRATEGY", saved.s], ["LOAM_PRUNE_SCORER", saved.sc]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
