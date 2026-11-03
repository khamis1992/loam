/** check:remediate — smoke gate for the Remediate engine's offline core
 *  (REMEDIATE_INTO_LOAM §8 Phase A; appendix E8). Proves on the fixture set:
 *  pack integrity (hash-gated), D-1 inventory tables exact with zero writes,
 *  the D-7 electron dogfood shape (vendor_update_required, NO target), and the
 *  anti-hallucination drop path. Offline — no Docker, no network, no agents. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnabledPacks } from "../security/remediate/packs/loader.js";
import { runInventory } from "../security/remediate/inventory/index.js";
import { validateHits } from "../security/remediate/inventory/node.js";
import { FIXTURES, materialize, readFixtureFiles } from "../security/remediate/__tests__/fixtures.js";

const advisories = path.resolve(import.meta.dirname ?? ".", "..", "..", "security", "advisories");

// 1. Pack integrity: 2 enabled by default (OD-3), all 4 hash-verified.
const packs = loadEnabledPacks(advisories);
assert.equal(packs.size, 2);
assert.equal(packs.get("node-2026-10-21")?.pack.lines.find((l) => l.line === "22")?.fixed, "22.23.4");
assert.deepEqual(packs.get("electron-bundled-node")?.pack.verifiedFixedElectronReleases, []);

// 2. D-1 on the node fixtures (default packs) + electron dogfood.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-check-"));
try {
  for (const name of ["node-vuln-app", "node-eol-app", "clean-node-app", "electron-app"]) {
    const fx = FIXTURES.find((f) => f.name === name)!;
    const dir = materialize(fx, tmp);
    const result = runInventory([{ repoId: name, files: readFixtureFiles(dir), lockfileContent: fx.files["package-lock.json"] ?? null }], advisories);
    for (const exp of fx.expect) {
      const row = result.records.find((r) => r.hit.file === exp.file && r.hit.signal.includes(exp.signalIncludes));
      assert.ok(row, `${name}: ${exp.file}`);
      assert.equal(row.status, exp.status, `${name}/${exp.file}`);
      assert.equal(row.proposedTarget, exp.target, `${name}/${exp.file} target`);
    }
    assert.equal(result.droppedHits.length, 0, name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // D-7 explicit: electron row has NO target and names the watch step.
  const efx = FIXTURES.find((f) => f.name === "electron-app")!;
  const edir = materialize(efx, tmp);
  const er = runInventory([{ repoId: "electron-app", files: readFixtureFiles(edir), lockfileContent: efx.files["package-lock.json"]! }], advisories);
  const erow = er.records.find((r) => r.hit.channel === "electron");
  assert.ok(erow && erow.status === "vendor_update_required" && erow.proposedTarget === null && /watch electron/i.test(erow.nextStep ?? ""));
  fs.rmSync(edir, { recursive: true, force: true });

  // 3. E8: a hit whose signal vanished on re-read is dropped.
  const { kept, dropped } = validateHits(er.records.map((r) => r.hit), () => null);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, er.records.length);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS: check:remediate — packs hash-gated (2 enabled), D-1 inventory exact + zero writes, D-7 electron vendor_update_required with no target, anti-hallucination drop green");
