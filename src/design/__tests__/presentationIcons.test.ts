import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { createPresentationIcons, PRESENTATION_ICON_IDS } from "../presentationIcons.js";

describe("presentation icons", () => {
  it("creates one transparent high-resolution outlined icon per section", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-icons-"));
    try {
      const icons = await createPresentationIcons(root, "#007A33");
      assert.deepEqual(Object.keys(icons).sort(), [...PRESENTATION_ICON_IDS].sort());
      for (const id of PRESENTATION_ICON_IDS) {
        const metadata = await sharp(icons[id].path).metadata();
        assert.equal(metadata.width, 64);
        assert.equal(metadata.height, 64);
        assert.equal(metadata.hasAlpha, true);
        assert.ok(fs.statSync(icons[id].path).size > 100);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid palette input", async () => {
    await assert.rejects(() => createPresentationIcons("unused", "green"), /#RRGGBB/);
  });
});
