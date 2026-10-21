/**
 * Unit tests for the V2 text-driven video edit agent (src/tools/videoEditAgent.ts).
 * Uses an in-memory mock TimelineService — no fs, no ffmpeg, no network.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, after } from "node:test";

import type { Tool, ToolContext, ToolRegistry } from "../../tools/registry.js";
import type { EdlOp, TimelineService, VideoEdl, VideoSourceInfo } from "../../tools/videoEditAgent.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-videoedit-"));
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

const sqlite = await import("../sqliteStore.js");
const registryMod = await import("../../tools/registry.js");
const videoMod = await import("../../tools/videoEditAgent.js");
const gatewayMod = await import("../companionGateway.js");
const catalogMod = await import("../../modes/catalog.js");
const runToolsMod = await import("../runTools.js");
const { resolveCompanionCapabilities, COMPANION_DYNAMIC_TOOL_NAMES, WORK_MODES } = gatewayMod;
const { LOAM_MODES } = catalogMod;
const { mergeAlwaysOnTools } = runToolsMod;
const { createVideoEditTools, compileEdl, computeSegments, parseTimeToken } = videoMod;

const registry: ToolRegistry = new registryMod.ToolRegistry();

after(() => {
  sqlite.closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

class MockTimelineService implements TimelineService {
  readonly saved: { file: string; edl: VideoEdl }[] = [];
  latest: VideoEdl | null = null;
  sourceExists = true;
  constructor(private readonly durationSec?: number) {}
  async inspectSource(_taskId: string, _workspace: string, sourcePath: string): Promise<VideoSourceInfo> {
    if (!this.sourceExists) throw new Error(`source video not found in the task workspace: ${sourcePath}`);
    return this.durationSec === undefined ? { path: sourcePath } : { path: sourcePath, durationSec: this.durationSec };
  }
  async loadLatestEdl(): Promise<VideoEdl | null> {
    return this.latest;
  }
  async saveEdl(_taskId: string, _workspace: string, edl: VideoEdl): Promise<{ file: string }> {
    const file = `uploads/mock-edl-${this.saved.length}.json`;
    this.saved.push({ file, edl });
    this.latest = edl;
    return { file };
  }
}

function dummyCtx(workspace: string): ToolContext {
  return {
    cfg: {} as never,
    workspace,
    emit: () => undefined,
    taskId: "task_videotest",
  };
}

function dummy(name: string): Tool {
  return {
    name,
    description: "test tool",
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "" };
    },
  };
}

describe("video edit agent: instruction → EDL", () => {
  it("parses timestamp tokens", () => {
    assert.equal(parseTimeToken("45"), 45);
    assert.equal(parseTimeToken("45s"), 45);
    assert.equal(parseTimeToken("90 seconds"), 90);
    assert.equal(parseTimeToken("1:30"), 90);
    assert.equal(parseTimeToken("01:30"), 90);
    assert.equal(parseTimeToken("1:02:03"), 3723);
    assert.equal(parseTimeToken("2m"), 120);
    assert.equal(parseTimeToken("1.5s"), 1.5);
    assert.equal(parseTimeToken("nope"), null);
  });

  it("compiles a multi-op instruction with source-relative timestamps", () => {
    const edl = compileEdl({
      instruction:
        'trim from 10s to 50s, delete 20-25, split at 0:35, move segment 2 to position 1, add text "Loam" at 3s for 4s at the bottom',
      sourcePath: "assets/video.mp4",
      durationSec: 60,
    });
    assert.equal(edl.version, 1);
    assert.deepEqual(edl.source, { path: "assets/video.mp4", durationSec: 60 });
    assert.deepEqual(
      edl.ops.map((o) => o.op),
      ["trim", "delete", "split", "reorder", "overlay-text"],
    );
    assert.deepEqual(edl.ops[0], { id: "op1", op: "trim", fromSec: 10, toSec: 50 });
    assert.deepEqual(edl.ops[1], { id: "op2", op: "delete", fromSec: 20, toSec: 25 });
    assert.deepEqual(edl.ops[2], { id: "op3", op: "split", atSec: 35 });
    assert.deepEqual(edl.ops[3], { id: "op4", op: "reorder", order: [2, 1, 3] });
    assert.deepEqual(edl.ops[4], { id: "op5", op: "overlay-text", text: "Loam", atSec: 3, durationSec: 4, position: "bottom" });
    assert.deepEqual(edl.summary, { outputDurationSec: 35, segmentCount: 3 });
    assert.equal(edl.warnings.length, 0, `unexpected warnings: ${edl.warnings.join(" | ")}`);
  });

  it("projects segments through trim/split/delete/reorder", () => {
    const ops: EdlOp[] = [
      { id: "a", op: "trim", fromSec: 10, toSec: 50 },
      { id: "b", op: "delete", fromSec: 20, toSec: 25 },
      { id: "c", op: "split", atSec: 35 },
    ];
    assert.deepEqual(computeSegments(ops, 60), [
      { fromSec: 10, toSec: 20 },
      { fromSec: 25, toSec: 35 },
      { fromSec: 35, toSec: 50 },
    ]);
    const reordered = [...ops, { id: "d", op: "reorder" as const, order: [3, 1, 2] }];
    assert.deepEqual(computeSegments(reordered, 60), [
      { fromSec: 35, toSec: 50 },
      { fromSec: 10, toSec: 20 },
      { fromSec: 25, toSec: 35 },
    ]);
    assert.equal(computeSegments(ops, undefined), null);
  });

  it("clamps beyond-duration timestamps and warns", () => {
    const edl = compileEdl({ instruction: "delete from 40s to 999s", sourcePath: "v.mp4", durationSec: 50 });
    assert.deepEqual(edl.ops, [{ id: "op1", op: "delete", fromSec: 40, toSec: 50 }]);
    assert.ok(edl.warnings.some((w) => w.includes("clamped")));
  });

  it("handles first/last N and drop-the-previous-verb clauses", () => {
    const edl = compileEdl({ instruction: "keep the first 30s, then remove the last 10s", sourcePath: "v.mp4", durationSec: 100 });
    assert.deepEqual(
      edl.ops.map((o) => o.op),
      ["trim", "delete"],
    );
    assert.deepEqual(edl.ops[0], { id: "op1", op: "trim", fromSec: 0, toSec: 30 });
    assert.deepEqual(edl.ops[1], { id: "op2", op: "delete", fromSec: 90, toSec: 100 });
  });

  it("inherits a verb for comma-joined ranges", () => {
    const edl = compileEdl({ instruction: "delete from 5s to 7s and from 10s to 12s", sourcePath: "v.mp4", durationSec: 60 });
    assert.deepEqual(
      edl.ops.map((o) => o.op),
      ["delete", "delete"],
    );
    assert.deepEqual(edl.ops[1], { id: "op2", op: "delete", fromSec: 10, toSec: 12 });
  });

  it("warns and skips ops that need an unknown duration", () => {
    const edl = compileEdl({ instruction: "remove the last 5 seconds, reorder 2 1", sourcePath: "v.mp4" });
    assert.equal(edl.ops.length, 0);
    assert.ok(edl.warnings.length >= 2, "both ops must produce warnings");
    assert.equal(edl.summary, undefined);
  });

  it("reports unparseable clauses instead of failing", () => {
    const edl = compileEdl({ instruction: "make it pop", sourcePath: "v.mp4", durationSec: 10 });
    assert.equal(edl.ops.length, 0);
    assert.ok(edl.warnings.some((w) => w.includes("could not interpret")));
  });

  it("preserves decimal timestamps inside a sentence", () => {
    const edl = compileEdl({ instruction: "split at 1.5s", sourcePath: "v.mp4", durationSec: 10 });
    assert.deepEqual(edl.ops, [{ id: "op1", op: "split", atSec: 1.5 }]);
  });
});

describe("video_edit tool with mock TimelineService", () => {
  const workspace = "/tmp/loam-video-test-workspace";

  it("returns the new EDL JSON and saves it", async () => {
    const timeline = new MockTimelineService(60);
    const tool = createVideoEditTools({ timeline })[0]!;
    assert.equal(tool.name, "video_edit");
    const res = await tool.run(
      { path: "assets/video.mp4", instruction: 'trim 10s to 40s then add text "Hi" at 2s for 3s' },
      dummyCtx(workspace),
    );
    assert.ok(res.ok, res.content);
    const payload = JSON.parse(res.content) as { savedTo: string; edl: VideoEdl };
    assert.equal(payload.savedTo, "uploads/mock-edl-0.json");
    assert.deepEqual(payload.edl.ops.map((o) => o.op), ["trim", "overlay-text"]);
    assert.equal(timeline.saved.length, 1);
  });

  it("fails cleanly when the source is missing", async () => {
    const timeline = new MockTimelineService(60);
    timeline.sourceExists = false;
    const tool = createVideoEditTools({ timeline })[0]!;
    const res = await tool.run({ path: "assets/gone.mp4", instruction: "trim 0s to 5s" }, dummyCtx(workspace));
    assert.equal(res.ok, false);
    assert.match(res.content, /source video not found/);
  });

  it("chains onto the saved EDL for the same source and honors reset", async () => {
    const timeline = new MockTimelineService(60);
    const tool = createVideoEditTools({ timeline })[0]!;
    const first = await tool.run({ path: "a.mp4", instruction: "delete 5s to 10s" }, dummyCtx(workspace));
    assert.ok(first.ok);
    const second = await tool.run({ path: "a.mp4", instruction: 'add text "End" at 1s for 2s' }, dummyCtx(workspace));
    const secondEdl = JSON.parse(second.content) as { edl: VideoEdl };
    assert.deepEqual(secondEdl.edl.ops.map((o) => o.op), ["delete", "overlay-text"]);
    const third = await tool.run({ path: "a.mp4", instruction: "reset, split at 20s" }, dummyCtx(workspace));
    const thirdEdl = JSON.parse(third.content) as { edl: VideoEdl };
    assert.deepEqual(thirdEdl.edl.ops, [{ id: "op1", op: "split", atSec: 20 }]);
    assert.ok(thirdEdl.edl.warnings.some((w) => w.includes("reset")));
    const other = await tool.run({ path: "b.mp4", instruction: "delete 1s to 2s" }, dummyCtx(workspace));
    const otherEdl = JSON.parse(other.content) as { edl: VideoEdl };
    assert.deepEqual(otherEdl.edl.ops.map((o) => o.op), ["delete"]);
    assert.ok(otherEdl.edl.warnings.some((w) => w.includes("different source")));
  });

  it("requires path and instruction", async () => {
    const tool = createVideoEditTools({ timeline: new MockTimelineService(60) })[0]!;
    assert.equal((await tool.run({ instruction: "trim 0s to 5s" }, dummyCtx(workspace))).ok, false);
    assert.equal((await tool.run({ path: "a.mp4" }, dummyCtx(workspace))).ok, false);
  });
});

for (const name of ["file_read", "file_write", "shell_run"]) registry.register(dummy(name));
registry.registerAll(createVideoEditTools());

describe("video_edit in the effective agent-run tool list (gateway + always-on)", () => {
  it("video_edit is registered but never leaks into the raw gateway allowlist", () => {
    const capabilities = resolveCompanionCapabilities({
      mode: "build",
      workMode: "loam",
      registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
    });
    assert.ok(registry.names().includes("video_edit"));
    assert.ok(!capabilities.allow.includes("video_edit"), "video_edit is an always-on tool, not a mode-catalog or service tool");
  });

  it("the model sees video_edit in every Loam mode and work mode", () => {
    for (const mode of LOAM_MODES) {
      const capabilities = resolveCompanionCapabilities({
        mode: mode.id,
        workMode: "loam",
        registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
      });
      const runAllow = mergeAlwaysOnTools({ resolvedAllow: capabilities.allow, registeredTools: registry.names() });
      const tools = registry.forAllowlist(runAllow);
      assert.ok(tools.names().includes("video_edit"), `mode ${mode.id} must expose video_edit`);
      assert.ok(tools.toOllama().some((t) => t.function.name === "video_edit"), `model function list for ${mode.id} must include video_edit`);
    }
    for (const workMode of WORK_MODES) {
      const capabilities = resolveCompanionCapabilities({
        mode: "build",
        workMode: workMode.id,
        registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
      });
      const runAllow = mergeAlwaysOnTools({ resolvedAllow: capabilities.allow, registeredTools: registry.names() });
      assert.ok(registry.forAllowlist(runAllow).names().includes("video_edit"), `work mode ${workMode.id} must expose video_edit`);
    }
  });

  it("per-agent disabledTools still removes video_edit", () => {
    const capabilities = resolveCompanionCapabilities({
      mode: "build",
      workMode: "loam",
      disabledTools: ["video_edit"],
      registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
    });
    const runAllow = mergeAlwaysOnTools({
      resolvedAllow: capabilities.allow,
      registeredTools: registry.names(),
      disabledTools: ["video_edit"],
    });
    assert.ok(!registry.forAllowlist(runAllow).names().includes("video_edit"), "agent tool denial must win over the always-on grant");
  });
});
