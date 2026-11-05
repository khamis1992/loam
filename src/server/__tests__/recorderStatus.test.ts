import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readRecorderStatus } from "../recorderStatus.js";

describe("recorder status", () => {
  it("reports the installed revision and hides it when the editor is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-recorder-status-"));
    try {
      const dist = path.join(root, "electron", "recorder", "dist");
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
      fs.writeFileSync(path.join(dist, ".vendor.json"), JSON.stringify({
        rev: "8ecc76b7735efcc17866929cdc05a7d877b17008",
      }));
      const present = readRecorderStatus(root);
      assert.equal(present.installed, true);
      assert.equal(present.name, "Loam Recorder");
      assert.equal(present.rev, "8ecc76b7735efcc17866929cdc05a7d877b17008");
      fs.rmSync(path.join(dist, "index.html"));
      const missing = readRecorderStatus(root);
      assert.equal(missing.installed, false);
      assert.equal(missing.rev, null);
      const packed = path.join(root, "app.asar");
      const bin = path.join(root, "app.asar.unpacked", "resources", "recorder", "bin", "win32-x64");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "wgc-capture.exe"), "");
      fs.writeFileSync(path.join(bin, "compositor_view.node"), "");
      const native = readRecorderStatus(packed);
      assert.equal(native.helper, "ok");
      assert.equal(native.compositor, "ok");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
