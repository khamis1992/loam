import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { VideoEdl } from "../workspace/videoRender.js";

let tmpDir = "";
let closeDb: () => void;
let mod: {
  buildFfmpegArgs: (edl: VideoEdl, source: string, out: string, hasAudio: boolean) => string[];
  normalizeEdl: (input: unknown, duration?: number) => VideoEdl;
  edlDuration: (edl: VideoEdl) => number;
  chooseOutputPath: (rel: string, root: string) => string;
  getRenderJob: (id: string) => { status: string } | undefined;
  parseProgress: (stderr: string) => number | undefined;
};

describe("workspace video render", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wsv-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const video = await import("../workspace/videoRender.js");
    mod = {
      buildFfmpegArgs: video.buildFfmpegArgs,
      normalizeEdl: video.normalizeEdl,
      edlDuration: video.edlDuration,
      chooseOutputPath: video.chooseOutputPath,
      getRenderJob: video.getRenderJob,
      parseProgress: video.parseProgress,
    };
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const source = "C:/media/src.mp4";
  const out = "C:/media/out.mp4";

  it("normalizes clips, clamps to source duration and rejects malformed input", () => {
    const edl = mod.normalizeEdl({
      version: 1, clips: [{ id: "a", in: -1, out: 8 }], overlays: [{ text: " hi\nthere ", start: 0, end: 2 }],
    }, 5) as { clips: { id: string; in: number; out: number }[]; overlays: { text: string; x: number }[] };
    assert.equal(edl.clips[0]!.in, 0);
    assert.equal(edl.clips[0]!.out, 5);
    assert.equal(edl.overlays[0]!.text, "hi there");
    assert.equal(edl.overlays[0]!.x, 10);
    assert.throws(() => mod.normalizeEdl({ clips: [] }, 5), /at least/);
    assert.throws(() => mod.normalizeEdl(null), /edl required/);
    assert.throws(() => mod.normalizeEdl({ clips: [{ in: 0, out: 0.01 }] }, 5), /segment/);
    assert.throws(() => mod.normalizeEdl({ clips: [{ in: 0, out: 1 }], overlays: [{ text: "", start: 0, end: 2 }] }), /text/);
    // Task-produced EDL variants: `segments` with start/end aliases.
    const alias = mod.normalizeEdl({ segments: [{ start: 1, end: 3 }] }, 10);
    assert.equal(alias.clips[0]!.in, 1);
    assert.equal(alias.clips[0]!.out, 3);
  });

  it("sums segment durations", () => {
    const edl = mod.normalizeEdl({ version: 1, clips: [{ in: 0, out: 2.5 }, { in: 3, out: 4.5 }] });
    assert.equal(mod.edlDuration(edl), 4);
  });

  it("builds single-clip args without audio mapping", () => {
    const edl = mod.normalizeEdl({ version: 1, clips: [{ in: 0, out: 2 }] });
    const args = mod.buildFfmpegArgs(edl, source, out, false) as string[];
    assert.ok(args.indexOf("-i") >= 0);
    assert.equal(args[args.indexOf("-i") + 1], source);
    assert.equal(args[args.length - 1], out);
    assert.ok(stringComplexSafe(args).includes("trim=start=0.000:end=2.000"));
    assert.ok(!stringComplexSafe(args).includes("atrim"));
    assert.ok(!stringComplexSafe(args).includes("aac"));
    assert.ok(!stringComplexSafe(args).includes("concat"));
  });

  it("adds audio trim + concat for multiple clips", () => {
    const edl = mod.normalizeEdl({ version: 1, clips: [{ in: 0, out: 2 }, { in: 4, out: 6 }] });
    const complex = (mod.buildFfmpegArgs(edl, source, out, true) as string []).find((a) => a.includes("concat"))!;
    assert.ok(complex.includes("atrim=start=4.000"), complex);
    assert.ok(complex.includes("concat=n=2:v=1:a=1"), complex);
    // concat consumes inputs interleaved per segment, not all video then all audio.
    assert.ok(complex.includes("[v0][a0][v1][a1]concat"), complex);
  });

  it("draws text overlays with escaped filter text and percent position", () => {
    const edl = mod.normalizeEdl({
      version: 1, clips: [{ in: 0, out: 2 }],
      overlays: [{ text: "A's: b, c\\d 50%", start: 0.5, end: 1.5, x: 25, y: 75 }],
    });
    const complex = stringComplexSafe(mod.buildFfmpegArgs(edl, source, out, false) as string[]);
    assert.ok(complex.includes("drawtext=text='A\\'s\\: b\\, c\\\\d 50\\%'"), complex);
    assert.ok(complex.includes("x=w*25.000/100:y=h*75.000/100"), complex);
    assert.ok(complex.includes("enable='between(t,0.500,1.500)'"), complex);
  });

  it("chooses unique output paths inside the task workspace", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "clip.mp4"), "x");
    const first = mod.chooseOutputPath("clip.mp4", tmpDir);
    assert.equal(path.join(tmpDir, first), path.join(tmpDir, "clip.edit.mp4"));
    fs.writeFileSync(path.join(tmpDir, "clip.edit.mp4"), "x");
    const second = mod.chooseOutputPath("clip.mp4", tmpDir);
    assert.equal(second, "clip.edit-2.mp4");
  });

  it("reads progress from -progress output", () => {
    assert.equal(mod.parseProgress("frame=10\nout_time_ms=1250000\nprogress=continue\n"), 1.25);
    assert.equal(mod.parseProgress("time=00:00:03.50 bitrate=1k"), 3.5);
    assert.equal(mod.parseProgress("no progress here"), undefined);
  });

  it("returns no job for unknown ids", () => {
    assert.equal(mod.getRenderJob("job_none"), undefined);
  });

  it("renders a real cut + overlay through the job queue when ffmpeg is installed", { timeout: 120_000 }, async () => {
    const video = await import("../workspace/videoRender.js");
    if (!video.ffmpegAvailable()) return; // unit-only environment
    const { execFileSync } = await import("node:child_process");
    const src = path.join(tmpDir, "live-src.mp4");
    execFileSync(video.ffmpegPath(), [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=600:duration=3",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      src,
    ], { windowsHide: true });
    const meta = await video.probeVideo(src);
    assert.equal(Math.round(meta.duration ?? 0), 3);
    assert.equal(meta.hasAudio, true);
    const edl = video.normalizeEdl({
      version: 1, clips: [{ in: 0, out: 1 }, { in: 2, out: 3 }],
      overlays: [{ text: "Hello", start: 0, end: 1.5, x: 30, y: 30 }],
    }, meta.duration);
    const job = video.startRender("task_live", "live-src.mp4", edl, tmpDir, meta.hasAudio);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const now = video.getRenderJob(job.id);
      if (now && now.status !== "queued" && now.status !== "running") {
        assert.equal(now.status, "done", now.error ?? "");
        break;
      }
    }
    const done = video.getRenderJob(job.id);
    assert.equal(done?.status, "done");
    const outAbs = path.join(tmpDir, done!.output ?? "");
    assert.ok(fs.statSync(outAbs).size > 0, "rendered file has bytes");
    const outMeta = await video.probeVideo(outAbs);
    assert.equal(Math.round(outMeta.duration ?? 0), 2, "cut length 1+1s");
    assert.equal(outMeta.hasAudio, true, "audio kept");
  });
});

function stringComplexSafe(args: string[]): string {
  const i = args.indexOf("-filter_complex");
  return args[i + 1] ?? "";
}
