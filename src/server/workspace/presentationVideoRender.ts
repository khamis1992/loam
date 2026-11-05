import fs from "node:fs";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { ffmpegAvailable, ffmpegPath, probeVideo } from "./videoRender.js";
import { taskPath } from "../taskWorkspace.js";

export interface PresentationVideoReviewFrame {
  path: string;
  label: "hook" | "middle" | "end";
  timeSec: number;
}

export interface PresentationVideoRenderResult {
  path: string;
  previewPath?: string;
  reviewFrames?: PresentationVideoReviewFrame[];
  motionPlanPath?: string;
  bytes: number;
  duration: number;
  hasAudio: boolean;
}

function runFfmpeg(args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill();
      finish(new Error("presentation video render cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("presentation video render timed out"));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-16_000); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0 ? undefined : new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`)));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function captureFrame(output: string, target: string, timeSec: number, signal?: AbortSignal): Promise<void> {
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", String(timeSec), "-i", output, "-frames:v", "1", "-y", target], signal, 15_000);
}

export async function renderPresentationVideo(taskRoot: string, previewPath: string, signal?: AbortSignal): Promise<PresentationVideoRenderResult> {
  if (!ffmpegAvailable()) throw new Error("ffmpeg is not installed for this build");
  const input = taskPath(taskRoot, previewPath);
  const relative = "uploads/presentation-video.mp4";
  fs.mkdirSync(taskPath(taskRoot, "uploads"), { recursive: true });
  fs.mkdirSync(taskPath(taskRoot, "previews"), { recursive: true });
  fs.mkdirSync(taskPath(taskRoot, "assets/video-review"), { recursive: true });
  const output = taskPath(taskRoot, relative);
  const png = fs.readFileSync(input);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("presentation preview is not a valid PNG");
  const filter = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xF7F7F2,zoompan=z='min(zoom+0.000125,1.03)':d=1:s=1920x1080:fps=30,fade=t=in:st=0:d=0.6,fade=t=out:st=7.4:d=0.6,format=yuv420p";
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-nostats", "-y",
    "-loop", "1", "-framerate", "30", "-i", input,
    "-vf", filter, "-t", "8", "-r", "30", "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-movflags", "+faststart", output,
  ], signal, 90_000);
  const metadata = await probeVideo(output);
  if (!metadata.duration || metadata.duration < 7.5 || metadata.duration > 8.5 || metadata.bytes < 1_000) {
    throw new Error("rendered presentation video failed duration or size verification");
  }

  const motionPlanPath = "assets/video-motion-plan.json";
  fs.writeFileSync(taskPath(taskRoot, motionPlanPath), JSON.stringify({
    durationSec: 8,
    fps: 30,
    audio: "silent",
    scenes: [
      { id: "hook", fromSec: 0, toSec: 0.6, motion: "fade-in" },
      { id: "reading", fromSec: 0.6, toSec: 7.4, motion: "slow-zoom", fromScale: 1, toScale: 1.03 },
      { id: "end", fromSec: 7.4, toSec: 8, motion: "fade-out" },
    ],
    reviewTimesSec: [0.7, 4, 7.4],
  }, null, 2));

  const previewRelative = "previews/presentation-video.png";
  const poster = taskPath(taskRoot, previewRelative);
  let hasPoster = true;
  try {
    await captureFrame(output, poster, 2, signal);
  } catch {
    hasPoster = false;
  }

  const reviewFrames: PresentationVideoReviewFrame[] = [];
  const review = [
    { label: "hook" as const, timeSec: 0.7 },
    { label: "middle" as const, timeSec: 4 },
    { label: "end" as const, timeSec: 7.4 },
  ];
  try {
    for (const item of review) {
      const relativeFrame = `assets/video-review/${item.label}.png`;
      const absoluteFrame = taskPath(taskRoot, relativeFrame);
      await captureFrame(output, absoluteFrame, item.timeSec, signal);
      const stats = await sharp(absoluteFrame).stats();
      if (fs.statSync(absoluteFrame).size < 1_000 || stats.channels.every((channel) => channel.stdev < 0.5)) {
        throw new Error(`video review frame ${item.label} is blank or unreadable`);
      }
      reviewFrames.push({ path: relativeFrame, ...item });
    }
  } catch {
    return {
      path: relative,
      ...(hasPoster ? { previewPath: previewRelative } : {}),
      motionPlanPath,
      bytes: metadata.bytes,
      duration: metadata.duration,
      hasAudio: metadata.hasAudio,
    };
  }
  return {
    path: relative,
    ...(hasPoster ? { previewPath: previewRelative } : {}),
    reviewFrames,
    motionPlanPath,
    bytes: metadata.bytes,
    duration: metadata.duration,
    hasAudio: metadata.hasAudio,
  };
}
