/**
 * Round-trip test for the MiroFish user-selected location preference.
 *
 * The location is a user setting (any country/city/region worldwide) that the
 * seed step treats as authoritative. It must survive a restart and malformed
 * persisted values must be dropped rather than trusted.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let tmpDir = "";
let settings: typeof import("../settings.js");

describe("location preference round-trip", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-location-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    settings = await import("../settings.js");
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("persists and restores a user-selected location", () => {
    settings.updateSettings({ location: { country: "Qatar", city: "Doha", region: "" } });
    settings.loadSettings();
    assert.deepEqual(settings.getSettings().location, { country: "Qatar", city: "Doha" });
  });

  it("drops a malformed persisted location", () => {
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({ theme: "dark", projectId: null, location: 42 }),
      "utf8",
    );
    settings.loadSettings();
    assert.equal(settings.getSettings().location, undefined);
  });
});
