import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { createVideoPackTools } from "../video/tools.js";
import { ffmpegPath } from "../../server/workspace/videoRender.js";
import { readPackProject } from "../present.js";
import type { Tool, ToolContext } from "../../tools/registry.js";
import type { AgentEvent } from "../../agent/events.js";

function makeSource(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", file], { windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`source ffmpeg exited ${code}`)));
  });
}

function context(workspace: string, events: AgentEvent[] = []): ToolContext {
  return { cfg: { model: "test" } as never, workspace, taskId: "task_video", packId: "loam-video", emit: (event) => events.push(event) };
}

function named(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

describe("loam-video service pack", () => {
  it("cuts a real MP4 with Arabic overlay, exports review frames and presents without Python", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-video-a7-"));
    try {
      await makeSource(path.join(workspace, "source.mp4"));
      const tools = named(createVideoPackTools({ sttUrl: "" }));
      const ctx = context(workspace);
      const imported = await tools.get("vmedia_import")!.run({ path: "source.mp4" }, ctx);
      assert.equal(imported.ok, true, imported.content);
      const timeline = await tools.get("vtimeline_get")!.run({}, ctx);
      const revision = (JSON.parse(timeline.content) as { revision: number }).revision;
      const edited = await tools.get("vtimeline_edit")!.run({
        expectedRevision: revision,
        edl: { clips: [{ id: "cut", in: 0, out: 1 }], overlays: [{ id: "arabic", text: "مرحباً بالكويت", start: 0, end: 1, x: 10, y: 75 }] },
      }, ctx);
      assert.equal(edited.ok, true, edited.content);
      const started = await tools.get("vexport")!.run({ action: "start" }, ctx);
      assert.equal(started.ok, true, started.content);
      const jobId = (JSON.parse(started.content) as { jobId: string }).jobId;
      let completed: { status: string; path?: string } | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = await tools.get("vexport")!.run({ action: "status", jobId }, ctx);
        assert.equal(status.ok, true, status.content);
        completed = JSON.parse(status.content) as { status: string; path?: string };
        if (completed.status === "done") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(completed?.status, "done");
      assert.ok(completed?.path && fs.statSync(path.join(workspace, completed.path)).size > 1000);
      const project = readPackProject(workspace, "loam-video");
      assert.equal(project?.items[0]?.state, "final");
      assert.equal((project?.data?.reviewFrames as unknown[]).length, 3);
      const events: AgentEvent[] = [];
      const presented = await tools.get("video_present")!.run({}, context(workspace, events));
      assert.equal(presented.ok, true, presented.content);
      assert.equal(events.filter((event) => event.type === "artifact_published").length, 1);
      assert.equal(events.some((event) => event.type === "done"), false);

      const rejected = await tools.get("vmedia_inspect")!.run({ path: "deck.pptx" }, ctx);
      assert.equal(rejected.ok, false);
      const stt = await tools.get("vtranscribe")!.run({}, ctx);
      assert.match(stt.content, /provider_not_configured/);
      const generation = await tools.get("vgenerate")!.run({ action: "submit", prompt: "Kuwait towers" }, ctx);
      assert.match(generation.content, /provider_not_configured/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves the editable project on cancellation and rejects stale timeline revisions", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-video-cancel-"));
    try {
      await makeSource(path.join(workspace, "source.mp4"));
      const tools = named(createVideoPackTools());
      const ctx = context(workspace);
      await tools.get("vmedia_import")!.run({ path: "source.mp4" }, ctx);
      const conflict = await tools.get("vtimeline_edit")!.run({ expectedRevision: 99, edl: { clips: [{ in: 0, out: 1 }], overlays: [] } }, ctx);
      assert.match(conflict.content, /revision_conflict/);
      const started = await tools.get("vexport")!.run({ action: "start" }, ctx);
      const jobId = (JSON.parse(started.content) as { jobId: string }).jobId;
      const cancelled = await tools.get("vexport")!.run({ action: "cancel", jobId }, ctx);
      assert.equal(cancelled.ok, true, cancelled.content);
      assert.match(cancelled.content, /editableProjectPreserved/);
      assert.equal(readPackProject(workspace, "loam-video")?.items[0]?.state, "authored");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
