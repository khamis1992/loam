/**
 * V4: auto video helpers (src/creative/auto.ts) tested with fixture probes only —
 * no real ffmpeg, matching the clean-room FilmCraft-referenced design (see NOTICE).
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  detectScenes, pickHighlights, computeReframe, buildCaptions, wrapCaptionText,
  planAutoEdit, parseSceneLog, parseLoudnessLog,
  type FrameDiff, type EnergySample, type Scene, type SubjectFrame, type MediaProbe,
} from "../auto.js";

const scenes = (specs: [number, number, number][]): Scene[] =>
  specs.map(([start, end, peak], index) => ({ index, start, end, peak }));

describe("detectScenes", () => {
  const diffs: FrameDiff[] = [
    { t: 0, score: 0.0 }, { t: 1, score: 0.2 }, { t: 2, score: 0.8 },
    { t: 3, score: 0.3 }, { t: 4, score: 0.1 }, { t: 5, score: 0.9 }, { t: 6, score: 0.4 },
  ];
  it("splits on descending threshold-crossing peaks", () => {
    const out = detectScenes(diffs, { threshold: 0.5 });
    assert.deepStrictEqual(out.map(s => [s.start, s.end, s.peak]), [[0, 2, 0], [2, 5, 0.8], [5, 6, 0.9]]);
  });
  it("merges cuts closer than minSceneSeconds keeping the stronger", () => {
    const near: FrameDiff[] = [
      { t: 2, score: 0.8 }, { t: 2.4, score: 0.95 }, { t: 3, score: 0.2 }, { t: 6, score: 0.1 },
    ];
    const out = detectScenes(near, { threshold: 0.5, minSceneSeconds: 1 });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[1]!.start, 2.4);
  });
  it("honors an explicit duration beyond the last sample", () => {
    const out = detectScenes([{ t: 1, score: 0.1 }], { threshold: 0.5, duration: 12 });
    assert.deepStrictEqual(out, [{ index: 0, start: 0, end: 12, peak: 0 }]);
  });
  it("rejects unsorted times and out-of-range scores", () => {
    assert.throws(() => detectScenes([{ t: 2, score: 0.5 }, { t: 1, score: 0.5 }]), /ascending/);
    assert.throws(() => detectScenes([{ t: 1, score: 1.5 }]), /0\.\.1/);
    assert.throws(() => detectScenes([], { threshold: 2 }), /threshold/);
  });
});

describe("pickHighlights", () => {
  const energy: EnergySample[] = [
    { start: 0, end: 10, energy: 0.1 }, { start: 10, end: 20, energy: 0.85 },
  ];
  const two = scenes([[0, 10, 0.2], [10, 20, 0.9]]);
  it("prefers the louder, sharper scene", () => {
    const out = pickHighlights(two, energy, { targetSeconds: 10 });
    assert.deepStrictEqual(out.map(c => [c.start, c.end, c.sceneIndex]), [[10, 20, 1]]);
  });
  it("fills the target across scenes and trims the last clip", () => {
    const out = pickHighlights(two, energy, { targetSeconds: 12, minClipSeconds: 1 });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out.reduce((s, c) => s + (c.end - c.start), 0), 12);
    assert.deepStrictEqual(out.map(c => c.start), [0, 10]);
  });
  it("slides maxClip windows inside long scenes", () => {
    const hot: EnergySample[] = [
      { start: 0, end: 20, energy: 0.05 }, { start: 20, end: 30, energy: 0.9 },
    ];
    const out = pickHighlights(scenes([[0, 30, 0.3]]), hot, { targetSeconds: 10, maxClipSeconds: 10 });
    assert.deepStrictEqual(out.map(c => [c.start, c.end]), [[20, 30]]);
  });
  it("validates inputs", () => {
    assert.throws(() => pickHighlights([], [], { targetSeconds: 5 }), /non-empty/);
    assert.throws(() => pickHighlights(scenes([[5, 1, 0]]), [], { targetSeconds: 5 }), /start < end/);
    assert.throws(() => pickHighlights(scenes([[0, 1, 0], [0.5, 2, 0]]), [], { targetSeconds: 5 }), /non-overlapping/);
    assert.throws(() => pickHighlights(scenes([[0, 1, 0]]), [{ start: 0, end: 1, energy: 2 }], { targetSeconds: 5 }), /0\.\.1/);
    assert.throws(() => pickHighlights(scenes([[0, 1, 0]]), [], { targetSeconds: 0 }), /targetSeconds/);
  });
});

describe("computeReframe", () => {
  it("crops 16:9 to 9:16 centered when no subjects are given", () => {
    const out = computeReframe({ width: 1920, height: 1080, aspect: 9 / 16, start: 0, end: 8 });
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0]!.crop, { x: 657, y: 0, width: 607, height: 1080 });
  });
  it("follows subject centroids between keyframes", () => {
    const subjects: SubjectFrame[] = [
      { t: 0, boxes: [{ x: 0.2, y: 0.4, w: 0.1, h: 0.2 }] },
      { t: 10, boxes: [{ x: 0.85, y: 0.4, w: 0.1, h: 0.2 }] },
    ];
    const out = computeReframe({ width: 1920, height: 1080, aspect: 9 / 16, subjects, start: 0, end: 20 });
    assert.strictEqual(out.length, 2);
    assert.ok(out[0]!.crop.x > 0 && out[0]!.crop.x < out[1]!.crop.x);
    assert.strictEqual(out[1]!.crop.x, 1920 - 607); // clamped at the right edge
  });
  it("keeps a square crop taller than wide portrait sources", () => {
    const out = computeReframe({ width: 1080, height: 1920, aspect: 1, start: 0, end: 4 });
    assert.deepStrictEqual(out[0]!.crop, { x: 0, y: 420, width: 1080, height: 1080 });
  });
  it("validates geometry", () => {
    assert.throws(() => computeReframe({ width: 0, height: 10, aspect: 1 }), /width\/height/);
    assert.throws(() => computeReframe({ width: 10, height: 10, aspect: 0 }), /aspect/);
    assert.throws(() => computeReframe({ width: 100, height: 100, aspect: 1, subjects: [{ t: 0, boxes: [{ x: 0.9, y: 0, w: 0.5, h: 0.5 }] }] }), /inside the frame/);
  });
});

describe("captions", () => {
  it("wraps words at maxChars without breaking them", () => {
    const lines = wrapCaptionText("the quick brown fox jumps over the lazy dog again", 20);
    assert.ok(lines.every(l => l.length <= 20));
    assert.strictEqual(lines.join(" "), "the quick brown fox jumps over the lazy dog again");
  });
  it("hard-splits oversized words", () => {
    assert.deepStrictEqual(wrapCaptionText("a".repeat(50), 42), ["a".repeat(42), "a".repeat(8)]);
  });
  it("builds monotonic cues, splits long segments and clamps overlap", () => {
    const cues = buildCaptions([
      { start: 0, end: 1, text: "hello there" },
      { start: 0.5, end: 2, text: "overlapping tail" },
      { start: 3, end: 30, text: "x ".repeat(60) },
    ], { maxChars: 42, maxSeconds: 5 });
    for (let i = 1; i < cues.length; i++) assert.ok(cues[i]!.start >= cues[i - 1]!.end - 1e-9);
    for (const c of cues) {
      assert.ok(c.text.length <= 42);
      assert.ok(c.end - c.start <= 5.001);
      assert.strictEqual(c.index, cues.indexOf(c));
    }
    assert.strictEqual(cues[0]!.text, "hello there");
    assert.ok(cues.length > 3, "long segment produced multiple cues");
  });
  it("skips blank text and rejects bad times", () => {
    assert.strictEqual(buildCaptions([{ start: 0, end: 1, text: "   " }]).length, 0);
    assert.throws(() => buildCaptions([{ start: 2, end: 1, text: "x" }]), /start < end/);
  });
});

describe("ffmpeg log parsers", () => {
  it("parses metadata=print scene scores", () => {
    const log = [
      "frame:0    pts:0       pts_time:0",
      "stream:0 packet",
      "lavfi.scene_score=0.012345",
      "frame:24   pts:24024   pts_time:1.001",
      "stream:0 packet",
      "lavfi.scene_score=0.85",
    ].join("\n");
    assert.deepStrictEqual(parseSceneLog(log), [{ t: 0, score: 0.012345 }, { t: 1.001, score: 0.85 }]);
  });
  it("parses ebur128 momentary loudness into windowed energy", () => {
    const log = [
      "[Parsed_ebur128_0] t: 999.9   M: -20.0 S: -21.0 I: -22.0",
      "[Parsed_ebur128_0] t: 1999.9  M: -60.0 S: -21.0 I: -22.0",
      "[Parsed_ebur128_0] t: 2999.9  M: -1.0  S: -21.0 I: -22.0",
    ].join("\n");
    const out = parseLoudnessLog(log);
    assert.deepStrictEqual(out.map(s => [s.start, Math.round(s.end * 1e4) / 1e4]), [[0.9999, 1.9999], [1.9999, 2.9999]]);
    assert.strictEqual(out[0]!.energy, 40 / 60);
    assert.strictEqual(out[1]!.energy, 0);
  });
});

describe("planAutoEdit", () => {
  const probe: MediaProbe = {
    frameDiffs: async () => [
      { t: 0, score: 0.1 }, { t: 2, score: 0.9 }, { t: 4, score: 0.1 },
      { t: 6, score: 0.8 }, { t: 8, score: 0.2 },
    ],
    audioEnergy: async () => [
      { start: 0, end: 4, energy: 0.9 }, { start: 4, end: 8, energy: 0.1 },
    ],
    subjects: async () => [{ t: 0, boxes: [{ x: 0.3, y: 0.3, w: 0.2, h: 0.4 }] }],
    transcribe: async () => [{ start: 0, end: 2, text: "first line of narration" }],
  };
  it("runs every lane through the injected probe", async () => {
    const plan = await planAutoEdit("clip.mp4", { aspect: 9 / 16, width: 1920, height: 1080, targetSeconds: 4 }, probe);
    assert.deepStrictEqual(plan.scenes.map(s => [s.start, s.end]), [[0, 2], [2, 6], [6, 8]]);
    assert.strictEqual(plan.clips.length, 1);
    assert.deepStrictEqual([plan.clips[0]!.start, plan.clips[0]!.end, plan.clips[0]!.sceneIndex], [2, 6, 1]);
    assert.strictEqual(plan.reframes.length, 1);
    assert.strictEqual(plan.captions[0]!.text, "first line of narration");
    assert.deepStrictEqual(plan.warnings, []);
  });
  it("degrades with warnings when lanes are missing", async () => {
    const plan = await planAutoEdit("clip.mp4", { duration: 8, targetSeconds: 30 }, { audioEnergy: probe.audioEnergy });
    assert.ok(plan.warnings.some(w => /frame-diff/.test(w)));
    assert.ok(plan.warnings.some(w => /transcript/), "transcript warning");
    assert.strictEqual(plan.scenes[0]!.end, 8);
    assert.strictEqual(plan.clips.length, 1);
  });
  it("falls back to one centered reframe window and peak-only ranking", async () => {
    const plan = await planAutoEdit("clip.mp4", { aspect: 1 / 2 }, { frameDiffs: probe.frameDiffs });
    assert.strictEqual(plan.reframes[0]!.crop.width, 540);
    assert.ok(plan.clips.length >= 1);
    assert.ok(plan.warnings.some(w => /audio-energy/.test(w)));
  });
});
