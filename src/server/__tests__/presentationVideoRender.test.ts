import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { ffmpegAvailable, probeVideo } from "../workspace/videoRender.js";
import { renderPresentationVideo } from "../workspace/presentationVideoRender.js";

describe("presentation video renderer", () => {
  it("renders a real MP4 and verifies hook, middle and end frames", { skip: !ffmpegAvailable() }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-video-review-"));
    try {
      fs.mkdirSync(path.join(root, "previews"), { recursive: true });
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#F7F7F2"/><rect x="80" y="80" width="1440" height="740" fill="#FFFFFF"/><circle cx="800" cy="400" r="180" fill="#007A33"/><text x="800" y="680" text-anchor="middle" font-family="Segoe UI" font-size="64" fill="#17231C">دولة الكويت</text></svg>';
      await sharp(Buffer.from(svg)).png().toFile(path.join(root, "previews", "slide-1.png"));
      const result = await renderPresentationVideo(root, "previews/slide-1.png");
      assert.equal(result.path, "uploads/presentation-video.mp4");
      assert.equal(result.reviewFrames?.length, 3);
      assert.deepEqual(result.reviewFrames?.map((frame) => frame.label), ["hook", "middle", "end"]);
      assert.ok(result.motionPlanPath);
      assert.ok(result.previewPath);
      for (const frame of result.reviewFrames ?? []) {
        const stats = await sharp(path.join(root, frame.path)).stats();
        assert.ok(stats.channels.some((channel) => channel.stdev > 0.5));
      }
      const video = await probeVideo(path.join(root, result.path));
      assert.equal(video.duration, 8);
      assert.equal(video.hasAudio, false);
      const plan = JSON.parse(fs.readFileSync(path.join(root, result.motionPlanPath!), "utf8")) as { scenes: unknown[] };
      assert.equal(plan.scenes.length, 3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
