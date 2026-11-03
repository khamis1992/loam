import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createCreativeStudioTools } from "../creativeStudio.js";

describe("creative_subtitles runtime probe", () => {
  it("fails in under 2s when the speech runtime is missing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-subs-"));
    const media = path.join(workspace, "clip.mp4");
    fs.writeFileSync(media, "not a video");
    const tool = createCreativeStudioTools({
      speechProbe: async () => "محرك التفريغ غير متاح. The speech runtime is not available.",
    }).find((item) => item.name === "creative_subtitles")!;
    const started = Date.now();
    const result = await tool.run({ mediaPath: "clip.mp4" }, { workspace, taskId: "task_subs", cfg: {} as never, emit: () => undefined });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.ok, false);
    assert.match(result.content, /محرك التفريغ/);
    assert.match(result.content, /speech runtime/i);
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});
