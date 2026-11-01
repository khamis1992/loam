/**
 * P2 acceptance: the new computerUse config keys (§2.3) — defaults, deep merge
 * over a user config, and the "unknown or invalid values fall back" rule.
 * Drives loadConfig through LOAM_CONFIG against a temp config file, the same
 * entry point the app uses.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULTS, loadConfig } from "../../../config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-adcfg-"));
const savedConfig = process.env.LOAM_CONFIG;
const savedRoot = process.env.LOAM_ROOT;

before(() => {
  // Keep loadConfig's mkdir side effects inside the temp dir, not the repo.
  process.env.LOAM_ROOT = tmp;
});

after(() => {
  if (savedConfig !== undefined) process.env.LOAM_CONFIG = savedConfig;
  else delete process.env.LOAM_CONFIG;
  if (savedRoot !== undefined) process.env.LOAM_ROOT = savedRoot;
  else delete process.env.LOAM_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function loadWith(raw: Record<string, unknown>) {
  const file = path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");
  process.env.LOAM_CONFIG = file;
  return loadConfig();
}

describe("computerUse config (agent-desktop keys)", () => {
  it("shipped defaults match the plan (§2.3)", () => {
    const c = DEFAULTS.computerUse;
    assert.equal(c.backend, "auto");
    assert.equal(c.allowHeaded, true);
    assert.deepEqual(c.agentDesktop, {
      stateRoot: "",
      snapshotTimeoutMs: 3000,
      maxRenderedLines: 400,
      trace: false,
      pruneOldSnapshots: true,
      postActionDelta: true,
      maxDeltaLines: 40,
    });
  });

  it("an explicit user config survives the merge", () => {
    const cfg = loadWith({
      computerUse: {
        enabled: true,
        backend: "legacy",
        allowHeaded: false,
        agentDesktop: { snapshotTimeoutMs: 8000, maxRenderedLines: 250, trace: true },
      },
    });
    assert.equal(cfg.computerUse.backend, "legacy");
    assert.equal(cfg.computerUse.allowHeaded, false);
    const ad = cfg.computerUse.agentDesktop!;
    assert.equal(ad.snapshotTimeoutMs, 8000);
    assert.equal(ad.maxRenderedLines, 250);
    assert.equal(ad.trace, true);
    // untouched keys keep their defaults through the deep merge
    assert.equal(ad.pruneOldSnapshots, true);
    assert.equal(ad.maxDeltaLines, 40);
  });

  it("invalid values fall back to the defaults, never crash", () => {
    const cfg = loadWith({
      computerUse: {
        backend: "quantum",
        allowHeaded: "nope",
        agentDesktop: { snapshotTimeoutMs: "slow", maxRenderedLines: -5, maxDeltaLines: 1e9, pruneOldSnapshots: "yes" },
      },
    });
    assert.equal(cfg.computerUse.backend, "auto");
    assert.equal(cfg.computerUse.allowHeaded, true);
    const ad = cfg.computerUse.agentDesktop!;
    assert.equal(ad.snapshotTimeoutMs, 3000);
    // -5 is a number, so it clamps to the documented floor (40), not the fallback.
    assert.equal(ad.maxRenderedLines, 40);
    assert.equal(ad.maxDeltaLines, 400);
    assert.equal(ad.pruneOldSnapshots, true);
  });

  it("numeric clamps stay inside the documented bounds", () => {
    const cfg = loadWith({
      computerUse: { agentDesktop: { snapshotTimeoutMs: 10, maxRenderedLines: 100000, maxDeltaLines: 0 } },
    });
    // loadConfig normalisation always fills the block, so a non-null assert is honest.
    const ad = cfg.computerUse.agentDesktop!;
    assert.equal(ad.snapshotTimeoutMs, 500);
    assert.equal(ad.maxRenderedLines, 4000);
    assert.equal(ad.maxDeltaLines, 5);
  });
});
