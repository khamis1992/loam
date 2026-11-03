import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnabledPacks, loadPack } from "../packs/loader.js";
import { canonicalSha256 } from "../types.js";

const dir = path.resolve(process.cwd(), "security", "advisories");

test("every pack parses, validates shape, and its hash matches the reviewed index", () => {
  const packs = loadEnabledPacks(dir);
  assert.equal(packs.size, 2); // OD-3: node + electron tracker enabled
  assert.ok(packs.get("node-2026-10-21"));
  assert.ok(packs.get("electron-bundled-node"));
  // Disabled packs load individually (rescan needs them) but not by default.
  const php = loadPack("php-2026-10-21", dir);
  const gitlab = loadPack("gitlab-2026-10-21", dir);
  assert.equal(php.pack.lines.length, 7);
  assert.equal(gitlab.pack.lines.length, 7);
});

test("every fixed line carries a sourceUrls entry (CI rule §6.4.5)", () => {
  for (const id of ["node-2026-10-21", "php-2026-10-21", "gitlab-2026-10-21", "electron-bundled-node"]) {
    const { pack } = loadPack(id, dir);
    assert.ok(pack.sourceUrls.length >= 1, id);
    for (const m of pack.mitigations ?? []) assert.equal(m.isFix, false, `${id}:${m.id}`);
  }
});

test("pack facts are the vendor-corroborated ones (spec §2.11)", () => {
  const node = loadPack("node-2026-10-21", dir).pack;
  assert.equal(node.lines.find((l) => l.line === "22")?.fixed, "22.23.4");
  assert.equal(node.lines.find((l) => l.line === "24")?.fixed, "24.22.1");
  assert.ok(node.cves.some((c) => c.id === "CVE-2026-111497"));
  const php = loadPack("php-2026-10-21", dir).pack;
  assert.equal(php.lines.find((l) => l.line === "8.3")?.fixed, "8.3.36");
  assert.deepEqual((php.forbiddenMitigations ?? []).sort(), ["RLIMIT_AS", "RLIMIT_DATA"]);
  const gl = loadPack("gitlab-2026-10-21", dir).pack;
  assert.equal(gl.lines.find((l) => l.line === "19.4")?.fixed, "19.4.3");
  const electron = loadPack("electron-bundled-node", dir).pack;
  assert.deepEqual(electron.verifiedFixedElectronReleases, []); // D-7: nothing verified
  assert.equal(electron.observed?.length, 2);
});

test("a tampered pack is refused with pack_hash_mismatch", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-packs-"));
  try {
    fs.cpSync(dir, tmp, { recursive: true });
    const victim = path.join(tmp, "node-2026-10-21.json");
    const body = JSON.parse(fs.readFileSync(victim, "utf8")) as Record<string, unknown>;
    body.title = "tampered";
    fs.writeFileSync(victim, JSON.stringify(body));
    assert.throws(() => loadEnabledPacks(tmp), /pack_hash_mismatch/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("default pack path resolves outside the ESM source layout", () => {
  assert.ok(loadEnabledPacks().has("node-2026-10-21"));
});

test("canonicalSha256 is stable under key order (E1: reaEvidence canonicalJson)", async () => {
  const a = canonicalSha256({ b: 1, a: { z: 2, y: 3 } });
  const b = canonicalSha256({ a: { y: 3, z: 2 }, b: 1 });
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});
