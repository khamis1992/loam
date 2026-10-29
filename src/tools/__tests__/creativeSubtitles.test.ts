/**
 * creative_subtitles tool tests: the caption pipeline (buildCaptions/toSrt/toVtt
 * in src/creative/auto.ts) wired onto a real media file in a temp task
 * workspace. Transcription is stubbed through the factory's deps seam, so no
 * ffmpeg and no STT server run here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { after, describe, it } from "node:test";

// Redirect DATA_DIR/LOAM_ROOT before any import that evaluates config.js
// (creativeStudio transitively pulls the task db through taskWorkspace/db).
import { cleanupIsolatedDataDir } from "../../test/isolation.js";

import {
  CREATIVE_STUDIO_TOOL_NAMES,
  createCreativeStudioTools,
} from "../creativeStudio.js";
import { COMPANION_SERVICES, uncoveredModeTools } from "../../server/companionGateway.js";
import { LOAM_MODES } from "../../modes/catalog.js";
import { classifyToolCall } from "../../policy/riskTier.js";
import type { Transcript } from "../../creative/transcript.js";
import type { ToolContext } from "../registry.js";

const closeDbMod = await import("../../server/sqliteStore.js");
after(() => {
  closeDbMod.closeDb();
  cleanupIsolatedDataDir();
});

const SEGMENTS = [
  { start: 0, end: 2.5, text: "مرحبًا بكم في الاستوديو الإبداعي" },
  { start: 2.5, end: 5.5, text: "الآن ننشئ ترجمات تلقائية للفيديو" },
];

function stubTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return { mediaPath: "", duration: 5.5, segments: SEGMENTS, ...overrides };
}

function makeCtx(workspace: string): ToolContext {
  return { cfg: {} as ToolContext["cfg"], workspace, emit: () => {}, taskId: "task_subtitles_test" } as ToolContext;
}

/** Temp workspace containing a fake media file at `rel`. */
function fixtureWorkspace(rel = "media/demo.wav"): { ws: string; mediaRel: string; mediaAbs: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-subtitles-ws-"));
  const mediaAbs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
  fs.writeFileSync(mediaAbs, "RIFFxxxxWAVEfake-pcm-bytes");
  return { ws, mediaRel: rel, mediaAbs };
}

function subtitlesTool(transcribeImpl?: (mediaPath: string) => Promise<Transcript>) {
  const tools = createCreativeStudioTools(transcribeImpl ? { transcribe: transcribeImpl } : {});
  const tool = tools.find((t) => t.name === "creative_subtitles");
  assert.ok(tool, "creative_subtitles must be instantiated");
  return tool!;
}

describe("creative_subtitles tool", () => {
  it("writes srt and vtt next to the media file by default (format=both)", async () => {
    const { ws, mediaRel, mediaAbs } = fixtureWorkspace();
    const seen: string[] = [];
    const tool = subtitlesTool(async (mediaPath) => {
      seen.push(mediaPath);
      return stubTranscript({ mediaPath });
    });
    const result = await tool.run({ mediaPath: mediaRel }, makeCtx(ws));

    assert.ok(result.ok, result.content);
    assert.deepEqual(seen, [mediaAbs], "transcribe receives the resolved absolute media path");
    const srt = fs.readFileSync(`${mediaAbs}.srt`, "utf8");
    const vtt = fs.readFileSync(`${mediaAbs}.vtt`, "utf8");
    // SRT: numbered blocks with HH:MM:SS,mmm --> ranges and the text
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:0[0-9],\d{3}\n/u);
    assert.ok(srt.includes("مرحبًا بكم في الاستوديو الإبداعي"), "srt must carry the transcript text");
    // VTT: WEBVTT header with HH:MM:SS.mmm ranges
    assert.ok(vtt.startsWith("WEBVTT\n"), "vtt must start with the WEBVTT header");
    assert.match(vtt, /00:00:00\.000 --> 00:00:0[0-9]\.\d{3}/u);
    assert.ok(vtt.includes("ترجمات تلقائية"), "vtt must carry the transcript text");
    // Arabic summary: segment count, cue count, duration, both output paths
    assert.ok(result.content.includes("2 مقطعًا صوتيًا"), result.content);
    assert.ok(result.content.includes("المدة 5.5"), result.content);
    assert.ok(result.content.includes(`${mediaRel}.srt`) && result.content.includes(`${mediaRel}.vtt`), result.content);
  });

  it("honors maxChars by wrapping every cue line", async () => {
    const { ws, mediaRel, mediaAbs } = fixtureWorkspace("media/long.wav");
    const tool = subtitlesTool(async () =>
      stubTranscript({
        duration: 4,
        segments: [{ start: 0, end: 4, text: "one two three four five six seven eight nine ten eleven twelve" }],
      }),
    );
    const result = await tool.run({ mediaPath: mediaRel, maxChars: 10 }, makeCtx(ws));

    assert.ok(result.ok, result.content);
    const blocks = fs.readFileSync(`${mediaAbs}.srt`, "utf8").trim().split("\n\n");
    assert.ok(blocks.length >= 4, "a 12-word line at 10 chars must wrap into several cues");
    for (const block of blocks) {
      const [index, timing, ...textLines] = block.split("\n");
      assert.match(String(index), /^\d+$/u);
      assert.match(String(timing), / --> /u);
      for (const line of textLines) assert.ok(line!.length <= 10, `cue line "${line}" exceeds maxChars=10`);
    }
  });

  it("format=srt writes only the srt sidecar", async () => {
    const { ws, mediaRel, mediaAbs } = fixtureWorkspace("media/only.mp4");
    const tool = subtitlesTool(async () => stubTranscript());
    const result = await tool.run({ mediaPath: mediaRel, format: "srt" }, makeCtx(ws));

    assert.ok(result.ok, result.content);
    assert.ok(fs.existsSync(`${mediaAbs}.srt`));
    assert.ok(!fs.existsSync(`${mediaAbs}.vtt`), "vtt must not be written when format=srt");
  });

  it("rejects a missing media file with a clear Arabic error", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-subtitles-ws-"));
    const tool = subtitlesTool(async () => stubTranscript());
    const result = await tool.run({ mediaPath: "media/missing.wav" }, makeCtx(ws));

    assert.equal(result.ok, false);
    assert.ok(result.content.includes("غير موجود"), result.content);
    assert.ok(result.content.includes("media/missing.wav"), result.content);
  });

  it("reports an honest Arabic message when transcription is unavailable", async () => {
    const { ws, mediaRel, mediaAbs } = fixtureWorkspace();
    const tool = subtitlesTool(async () => {
      throw new Error("STT server error: 503");
    });
    const result = await tool.run({ mediaPath: mediaRel }, makeCtx(ws));

    assert.equal(result.ok, false);
    assert.ok(result.content.includes("تعذّر تفريغ"), result.content);
    assert.ok(result.content.includes("STT server error: 503"), "the underlying reason must surface");
    assert.ok(!fs.existsSync(`${mediaAbs}.srt`) && !fs.existsSync(`${mediaAbs}.vtt`), "no sidecars on failure");
  });

  it("requires an active task and rejects paths outside the workspace", async () => {
    const { ws, mediaRel } = fixtureWorkspace();
    const tool = subtitlesTool(async () => stubTranscript());

    const noTask = await tool.run({ mediaPath: mediaRel }, { cfg: {} as ToolContext["cfg"], workspace: ws, emit: () => {} } as ToolContext);
    assert.equal(noTask.ok, false);
    assert.ok(noTask.content.includes("مهمة نشطة مطلوبة"), noTask.content);

    const outside = await tool.run({ mediaPath: "../escape.wav" }, makeCtx(ws));
    assert.equal(outside.ok, false);
    assert.ok(outside.content.includes("خارج مساحة المهمة"), outside.content);
  });

  it("validates format and maxChars", async () => {
    const { ws, mediaRel } = fixtureWorkspace();
    const tool = subtitlesTool(async () => stubTranscript());

    const badFormat = await tool.run({ mediaPath: mediaRel, format: "ass" }, makeCtx(ws));
    assert.equal(badFormat.ok, false);
    assert.ok(badFormat.content.includes("format"), badFormat.content);

    const badChars = await tool.run({ mediaPath: mediaRel, maxChars: 0 }, makeCtx(ws));
    assert.equal(badChars.ok, false);
    assert.ok(badChars.content.includes("maxChars"), badChars.content);
  });
});

describe("creative_subtitles registration", () => {
  it("is declared and instantiated with the sibling creative studio tools", () => {
    assert.ok(CREATIVE_STUDIO_TOOL_NAMES.includes("creative_subtitles"));
    const names = createCreativeStudioTools().map((t) => t.name);
    assert.deepEqual(names, [...CREATIVE_STUDIO_TOOL_NAMES], "factory output must match the declared names");
  });

  it("rides the same allowlists as the sibling creative tools", () => {
    const creativeService = COMPANION_SERVICES.find((s) => s.id === "creative");
    assert.ok(creativeService?.tools.includes("creative_subtitles"), "companion gateway creative service");
    const media = LOAM_MODES.find((m) => m.id === "media");
    assert.ok(media?.tools.includes("creative_subtitles"), "media (Loam Studio) mode list");
    // Covered by the creative service, so the gateway intersection can never
    // silently drop it (same assertion style as semanticSearch.test.ts).
    assert.ok(!uncoveredModeTools().includes("creative_subtitles"), "creative_subtitles must belong to a service group");
    // Same risk tier family as the other media-analysis tools that shell out.
    assert.equal(classifyToolCall("creative_subtitles", { mediaPath: "a.wav" }), "exec");
  });
});
