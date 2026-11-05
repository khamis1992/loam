import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createImagePackTools } from "../image/tools.js";
import { createAudioPackTools } from "../audio/tools.js";
import type { ToolContext } from "../../tools/registry.js";
import type { AgentEvent } from "../../agent/events.js";
import { resolvePackId } from "../intent.js";

function context(workspace: string, packId: "loam-image" | "loam-audio", events: AgentEvent[] = []): ToolContext {
  return { cfg: { model: "test" } as never, workspace, taskId: "task_media", packId, emit: (event) => events.push(event) };
}

describe("image and audio service packs", () => {
  it("creates a real SVG locally and reports raster generation honestly when unconfigured", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-image-pack-"));
    try {
      const tools = new Map(createImagePackTools().map((tool) => [tool.name, tool]));
      const generated = await tools.get("image_generate")!.run({ prompt: "شعار هندسي لمتحف الفن الإسلامي", title: "Museum", format: "svg" }, context(workspace, "loam-image"));
      assert.equal(generated.ok, true, generated.content);
      const output = JSON.parse(generated.content) as { path: string };
      assert.ok(fs.statSync(path.join(workspace, output.path)).size > 100);
      assert.match(fs.readFileSync(path.join(workspace, output.path), "utf8"), /<svg/);
      const raster = await tools.get("image_generate")!.run({ prompt: "Museum", format: "png" }, context(workspace, "loam-image"));
      assert.match(raster.content, /provider_not_configured/);
      const events: AgentEvent[] = [];
      const presented = await tools.get("image_present")!.run({}, context(workspace, "loam-image", events));
      assert.equal(presented.ok, true, presented.content);
      assert.equal(events.filter((event) => event.type === "artifact_published").length, 1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("writes real provider audio and returns provider_not_configured when absent", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-audio-pack-"));
    try {
      const missing = new Map(createAudioPackTools({}).map((tool) => [tool.name, tool]));
      const unavailable = await missing.get("tts_generate")!.run({ prompt: "مرحباً" }, context(workspace, "loam-audio"));
      assert.match(unavailable.content, /provider_not_configured/);
      const tools = new Map(createAudioPackTools({
        tts: { generate: async () => ({ bytes: Buffer.alloc(2048, 1), mime: "audio/mpeg", extension: "mp3" }) },
      }).map((tool) => [tool.name, tool]));
      const generated = await tools.get("tts_generate")!.run({ prompt: "مرحباً بالكويت", voice: "ar" }, context(workspace, "loam-audio"));
      assert.equal(generated.ok, true, generated.content);
      const output = JSON.parse(generated.content) as { path: string };
      assert.equal(fs.statSync(path.join(workspace, output.path)).size, 2048);
      const events: AgentEvent[] = [];
      const presented = await tools.get("audio_present")!.run({}, context(workspace, "loam-audio", events));
      assert.equal(presented.ok, true, presented.content);
      assert.equal(events.filter((event) => event.type === "artifact_published").length, 1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("routes all new goals to their own pack without changing unsupported mobile", () => {
    assert.equal(resolvePackId({ studioGoal: "image" }), "loam-image");
    assert.equal(resolvePackId({ studioGoal: "audio" }), "loam-audio");
    assert.equal(resolvePackId({ studioGoal: "document" }), "loam-office");
    assert.equal(resolvePackId({ loamMode: "research" }), "loam-research");
    assert.equal(resolvePackId({ loamMode: "automate" }), "loam-schedule");
    assert.equal(resolvePackId({ studioGoal: "mobile-app" }), "loam-mobile");
    assert.equal(resolvePackId({ studioGoal: "game-development" }), "loam-game");
  });
});
