/**
 * Engine installer supply-chain tests (spec O-3): downloads must be pinned and
 * verified, not merely recorded after the fact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-installer-"));

describe("engine installer pins", () => {
  it("ships trusted version+sha256 pins for every engine", async () => {
    const { ENGINE_PINS } = await import("../../../scripts/red-install-engines.js");
    for (const engine of ["nuclei", "ffuf", "ysoserial", "sqlmap"]) {
      assert.ok(ENGINE_PINS[engine], `${engine} must have a trusted pin`);
      assert.ok(ENGINE_PINS[engine].version.length > 0);
      assert.match(ENGINE_PINS[engine].sha256, /^[a-f0-9]{64}$/);
      assert.match(ENGINE_PINS[engine].url, /^https:\/\//);
    }
  });

  it("assertSha256 accepts the exact digest and rejects a mismatch", async () => {
    const { assertSha256 } = await import("../../../scripts/red-install-engines.js");
    const root = tempRoot();
    const file = path.join(root, "artifact.bin");
    fs.writeFileSync(file, "abc");
    const good = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert.doesNotThrow(() => assertSha256(file, good));
    assert.throws(() => assertSha256(file, "0".repeat(64)), /sha256 mismatch/);
  });
});
