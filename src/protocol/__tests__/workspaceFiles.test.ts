import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { snapshotWorkspaceFiles } from "../socket.js";

describe("workspace file scan", () => {
  it("sees a recording outside .loam and skips the hidden capture directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scan-"));
    try {
      const hidden = path.join(root, ".loam", "recordings");
      const visible = path.join(root, "recordings");
      fs.mkdirSync(hidden, { recursive: true });
      fs.mkdirSync(visible, { recursive: true });
      fs.writeFileSync(path.join(hidden, "recording.mp4"), "hidden");
      fs.writeFileSync(path.join(visible, "recording.mp4"), "visible");
      const names = snapshotWorkspaceFiles(root).map((file) => file.rel);
      assert.equal(names.includes("recordings/recording.mp4"), true);
      assert.equal(names.some((name) => name.includes(".loam")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
