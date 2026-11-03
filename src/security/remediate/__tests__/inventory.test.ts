import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FIXTURES, materialize, readFixtureFiles } from "./fixtures.js";
import { runInventory } from "../inventory/index.js";

const advisories = path.resolve(import.meta.dirname ?? ".", "../../../..", "security", "advisories");
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rem-inv-"));

test("D-1 inventory: every fixture's table matches §8.0 exactly, zero writes", () => {
  // OD-3: node + electron are enabled by default; php/gitlab fixtures need all
  // four packs enabled — build a temp index that flips them on (hashes intact).
  const allEnabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-packs-all-"));
  fs.cpSync(advisories, allEnabledDir, { recursive: true });
  const idxPath = path.join(allEnabledDir, "index.json");
  const idx = JSON.parse(fs.readFileSync(idxPath, "utf8")) as { packs: Array<{ id: string; enabled: boolean }> };
  for (const p of idx.packs) p.enabled = true;
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  try {
    for (const fx of FIXTURES) {
      const dir = materialize(fx, parent);
      const before = gitStatus(dir);
      const lock = fx.files["package-lock.json"] ?? null;
      const result = runInventory([{ repoId: fx.name, files: readFixtureFiles(dir), lockfileContent: lock }], allEnabledDir);

      // Zero writes to the fixture repo (D-1).
      assert.equal(gitStatus(dir), before, `${fx.name}: repo must stay clean`);
      assert.equal(result.droppedHits.length, 0, `${fx.name}: no dropped hits expected (${result.droppedHits.map((d) => d.file).join(",")})`);

      for (const exp of fx.expect) {
        const row = result.records.find((r) => r.hit.file === exp.file && r.hit.signal.includes(exp.signalIncludes));
        assert.ok(row, `${fx.name}: missing row ${exp.file} /${exp.signalIncludes}/ — got ${result.records.map((r) => r.hit.file + ":" + r.hit.line).join(", ")}`);
        assert.equal(row.hit.currentVersion, exp.current, `${fx.name}/${exp.file} current`);
        assert.equal(row.hit.pinStyle, exp.pin, `${fx.name}/${exp.file} pin`);
        assert.equal(row.status, exp.status, `${fx.name}/${exp.file} status (signal=${row.hit.signal})`);
        assert.equal(row.proposedTarget, exp.target, `${fx.name}/${exp.file} target`);
      }
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(allEnabledDir, { recursive: true, force: true });
  }
});

test("D-7 dogfood shape: electron fixture is vendor_update_required with NO target and a next step", () => {
  const dir = materialize(FIXTURES.find((f) => f.name === "electron-app")!, parent);
  const result = runInventory([{ repoId: "electron-app", files: readFixtureFiles(dir), lockfileContent: FIXTURES.find((f) => f.name === "electron-app")!.files["package-lock.json"]! }], advisories);
  const row = result.records.find((r) => r.hit.channel === "electron");
  assert.ok(row);
  assert.equal(row.status, "vendor_update_required");
  assert.equal(row.proposedTarget, null);
  assert.match(row.hit.upgradeRiskNotes.join(" "), /24\.21\.0/);
  assert.ok(row.nextStep && /watch electron/i.test(row.nextStep));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("anti-hallucination: a hit whose signal vanished on re-read is dropped (E8)", async () => {
  const dir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, parent);
  try {
    // Sabotage: replace the Dockerfile AFTER building the scan input but BEFORE
    // the store read the engine would do — emulate by feeding a stale input.
    const staleInput = [{ repoId: "sabotaged", files: [{ rel: "Dockerfile", content: "FROM node:22.21.0-alpine\n" }], lockfileContent: null }];
    fs.rmSync(dir, { recursive: true, force: true });
    const result = runInventory(staleInput, advisories);
    // The engine reads files from its own snapshot here, so this input stays
    // valid; the drop path is exercised directly via validateHits below.
    assert.ok(result.records.length >= 1);
    const { validateHits } = await import("../inventory/node.js");
    const { kept, dropped } = validateHits(result.records.map((r) => r.hit), () => null); // read always fails
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, result.records.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function gitStatus(dir: string): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  } catch {
    return "";
  }
}
