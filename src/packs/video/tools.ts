import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type { Tool, ToolContext, ToolResult } from "../../tools/registry.js";
import { str } from "../../tools/registry.js";
import { readPackProject, writePackProject, presentPackProject } from "../present.js";
import type { PackProject } from "../types.js";
import { taskPath } from "../../server/taskWorkspace.js";
import { cancelRender, edlDuration, ffmpegPath, getRenderJob, normalizeEdl, probeVideo, startRender, type VideoEdl } from "../../server/workspace/videoRender.js";
import { httpSttBackend, transcribe, type SttBackend } from "../../creative/transcript.js";
import type { VideoProvider } from "./provider.js";

interface VideoData {
  sourcePath?: string;
  durationSec?: number;
  hasAudio?: boolean;
  edl?: VideoEdl;
  transcriptPath?: string;
  jobId?: string;
  reviewFrames?: Array<{ label: "hook" | "middle" | "end"; path: string; timeSec: number }>;
  motionPlanPath?: string;
  generationJobId?: string;
}

export interface VideoPackOptions {
  provider?: VideoProvider;
  stt?: SttBackend;
  sttUrl?: string;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], handler: Handler): Tool {
  return {
    name,
    description,
    parameters: { type: "object", additionalProperties: false, properties, required },
    async run(args, ctx) {
      try {
        return await handler(args, ctx);
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function json(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

function project(ctx: ToolContext): PackProject {
  const value = readPackProject(ctx.workspace, "loam-video");
  if (!value) throw new Error("video project is missing; import and inspect a real video first");
  return value;
}

function dataOf(value: PackProject): VideoData {
  return (value.data ?? {}) as VideoData;
}

function save(ctx: ToolContext, value: PackProject, data: VideoData): void {
  value.data = { ...value.data, ...data } as unknown as Record<string, unknown>;
  writePackProject(ctx.workspace, { ...value, revision: value.revision + 1 });
}

function sourceOf(value: PackProject): string {
  const source = dataOf(value).sourcePath;
  if (!source) throw new Error("video source is missing");
  return source;
}

async function inspect(ctx: ToolContext, input: string): Promise<{ path: string; duration: number; bytes: number; hasAudio: boolean }> {
  if (!/\.(?:mp4|m4v|webm|mov|mkv|avi)$/i.test(input)) throw new Error("a real video file is required; PPTX and images are not video sources");
  const absolute = taskPath(ctx.workspace, input);
  const metadata = await probeVideo(absolute);
  if (!metadata.duration || metadata.duration <= 0 || metadata.bytes <= 1_000) throw new Error("video duration or size is invalid");
  return { path: input, duration: metadata.duration, bytes: metadata.bytes, hasAudio: metadata.hasAudio };
}

function initialEdl(duration: number): VideoEdl {
  return normalizeEdl({ clips: [{ id: "source", in: 0, out: duration }], overlays: [] }, duration);
}

function capture(output: string, target: string, timeSec: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-ss", String(timeSec), "-i", output, "-frames:v", "1", "-y", target], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("review frame capture timed out")); }, 15_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => { child.kill(); finish(new Error("review frame capture cancelled")); };
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0 ? undefined : new Error(`frame capture failed: ${stderr}`)));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function review(ctx: ToolContext, output: string, duration: number): Promise<VideoData> {
  const absolute = taskPath(ctx.workspace, output);
  const reviewDir = taskPath(ctx.workspace, "assets/video-review");
  fs.mkdirSync(reviewDir, { recursive: true });
  const frames: NonNullable<VideoData["reviewFrames"]> = [];
  const points = [
    { label: "hook" as const, timeSec: Math.min(0.2, duration / 3) },
    { label: "middle" as const, timeSec: duration / 2 },
    { label: "end" as const, timeSec: Math.max(0, duration - 0.1) },
  ];
  for (const point of points) {
    const relative = `assets/video-review/${path.basename(output, ".mp4")}-${point.label}.png`;
    const target = taskPath(ctx.workspace, relative);
    await capture(absolute, target, point.timeSec, ctx.signal);
    const stats = await sharp(target).stats();
    if (fs.statSync(target).size < 500 || stats.channels.every((channel) => channel.stdev < 0.25)) throw new Error(`review frame ${point.label} is blank`);
    frames.push({ ...point, path: relative });
  }
  const motionPlanPath = "assets/video-motion-plan.json";
  fs.writeFileSync(taskPath(ctx.workspace, motionPlanPath), JSON.stringify({ durationSec: duration, reviewTimesSec: points.map((point) => point.timeSec), scenes: points }, null, 2));
  return { reviewFrames: frames, motionPlanPath };
}

export function createVideoPackTools(options: VideoPackOptions = {}): Tool[] {
  const importMedia = async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const metadata = await inspect(ctx, str(args, "path"));
    if (str(args, "action", "import") === "inspect") return json(metadata);
    const existing = readPackProject(ctx.workspace, "loam-video");
    if (existing) return json({ attached: true, project: existing, metadata });
    const value: PackProject = {
      projectId: ctx.taskId ?? "local-video",
      packId: "loam-video",
      revision: 0,
      items: [{ id: "video-1", state: "authored" }],
      data: { sourcePath: metadata.path, durationSec: metadata.duration, hasAudio: metadata.hasAudio, edl: initialEdl(metadata.duration) },
    };
    writePackProject(ctx.workspace, value);
    return json({ project: value, metadata });
  };

  return [
    tool("vproj_manage", "Create or attach one editable video project without replacing existing user work.", {
      action: { type: "string", enum: ["attach"] },
    }, [], async (_args, ctx) => json({ project: project(ctx) })),

    tool("vmedia_import", "Import a real MP4/MOV/WebM video into one editable project. Rejects presentations and fake media.", {
      path: { type: "string" },
      action: { type: "string", enum: ["import", "inspect"] },
    }, ["path"], importMedia),

    tool("vmedia_inspect", "Probe real video duration, byte size and audio without opening the visual studio.", {
      path: { type: "string" },
    }, ["path"], async (args, ctx) => json(await inspect(ctx, str(args, "path")))),

    tool("vtimeline_get", "Read the current normalized EDL and project revision before making any timeline edit.", {}, [], async (_args, ctx) => {
      const value = project(ctx);
      return json({ revision: value.revision, edl: dataOf(value).edl, sourcePath: sourceOf(value) });
    }),

    tool("vtimeline_edit", "Replace the EDL only at an expected revision. Supports real trim, reorder and timed text overlays while preserving the source.", {
      expectedRevision: { type: "integer", minimum: 0 },
      edl: { type: "object" },
    }, ["expectedRevision", "edl"], async (args, ctx) => {
      const value = project(ctx);
      if (args.expectedRevision !== value.revision) return { ok: false, content: JSON.stringify({ error: "revision_conflict", expected: value.revision }) };
      const data = dataOf(value);
      const edl = normalizeEdl(args.edl, data.durationSec);
      if (edlDuration(edl) <= 0) throw new Error("timeline is empty");
      const item = value.items[0];
      if (item) item.state = "authored";
      save(ctx, value, { edl });
      return json({ revision: value.revision, edl, durationSec: edlDuration(edl) });
    }),

    tool("vtranscribe", "Transcribe through the explicitly configured LOAM_STT_URL service. No Whisper runtime is bundled.", {
      language: { type: "string" },
    }, [], async (args, ctx) => {
      const value = project(ctx);
      const source = sourceOf(value);
      const sttUrl = options.sttUrl ?? process.env.LOAM_STT_URL;
      if (!options.stt && !sttUrl) return { ok: false, content: JSON.stringify({ error: "provider_not_configured", capability: "stt", setting: "LOAM_STT_URL" }) };
      const result = await transcribe(taskPath(ctx.workspace, source), options.stt ?? httpSttBackend(sttUrl!));
      const transcriptPath = ".loam/packs/loam-video/transcript.json";
      const absolute = taskPath(ctx.workspace, transcriptPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, JSON.stringify({ language: str(args, "language") || result.language, ...result }, null, 2));
      save(ctx, value, { transcriptPath });
      return json({ transcriptPath, segments: result.segments.length, language: result.language });
    }),

    tool("vexport", "Start, inspect or cancel a real FFmpeg render. Completion requires valid duration/size and hook/middle/end review frames.", {
      action: { type: "string", enum: ["start", "status", "cancel"] },
      jobId: { type: "string" },
    }, ["action"], async (args, ctx) => {
      const value = project(ctx);
      const data = dataOf(value);
      const action = str(args, "action");
      if (action === "start") {
        if (!data.edl) throw new Error("timeline is missing");
        const job = startRender(ctx.taskId ?? value.projectId, sourceOf(value), data.edl, ctx.workspace, data.hasAudio === true);
        save(ctx, value, { jobId: job.id });
        return json({ jobId: job.id, status: job.status, output: job.output });
      }
      const jobId = str(args, "jobId") || data.jobId;
      if (!jobId) throw new Error("export jobId is missing");
      const job = getRenderJob(jobId);
      if (!job) throw new Error("export job not found");
      if (action === "cancel") {
        cancelRender(jobId);
        const current = getRenderJob(jobId);
        return json({ jobId, status: current?.status ?? "cancelled", editableProjectPreserved: true });
      }
      if (job.status === "error" || job.status === "canceled") return { ok: false, content: JSON.stringify({ jobId, status: job.status, error: job.error }) };
      if (job.status !== "done") return json({ jobId, status: job.status, progress: job.progress });
      const metadata = await probeVideo(taskPath(ctx.workspace, job.output));
      if (!metadata.duration || metadata.bytes <= 1_000 || !data.edl || Math.abs(metadata.duration - edlDuration(data.edl)) > 0.25) throw new Error("rendered video failed duration or size verification");
      const verification = await review(ctx, job.output, metadata.duration);
      const item = value.items[0] ?? { id: "video-1", state: "final" as const };
      item.state = "final";
      item.path = job.output;
      value.items = [item];
      save(ctx, value, { ...verification, jobId });
      return json({ jobId, status: "done", path: job.output, bytes: metadata.bytes, durationSec: metadata.duration, ...verification });
    }),

    tool("vgenerate", "Submit or poll an optional text-to-video provider. Never reroutes to an unrelated video editor when no provider is configured.", {
      action: { type: "string", enum: ["submit", "poll"] },
      prompt: { type: "string" },
      jobId: { type: "string" },
      durationSec: { type: "number", minimum: 1, maximum: 60 },
      aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
    }, ["action"], async (args, ctx) => {
      if (!options.provider) return { ok: false, content: JSON.stringify({ error: "provider_not_configured", capability: "video" }) };
      const value = project(ctx);
      if (str(args, "action") === "submit") {
        const submitted = await options.provider.submit({ prompt: str(args, "prompt"), ...(typeof args.durationSec === "number" ? { durationSec: args.durationSec } : {}), ...(typeof args.aspectRatio === "string" ? { aspectRatio: args.aspectRatio as "16:9" | "9:16" | "1:1" } : {}) });
        save(ctx, value, { generationJobId: submitted.jobId });
        return json(submitted);
      }
      const jobId = str(args, "jobId") || dataOf(value).generationJobId;
      if (!jobId) throw new Error("generation jobId is missing");
      const result = await options.provider.poll(jobId);
      if (result.status === "done" && result.path) {
        const item = value.items[0] ?? { id: "video-1", state: "final" as const };
        item.state = "final";
        item.path = result.path;
        value.items = [item];
        save(ctx, value, dataOf(value));
      }
      return json(result);
    }),

    tool("video_present", "Host-only gate that publishes a verified MP4 into the existing Loam Video workspace surface.", {}, [], async (_args, ctx) => {
      const value = project(ctx);
      const artifacts = value.items.flatMap((item) => item.state === "final" && item.path ? [{ path: item.path, kind: "video" as const, title: item.id, mime: "video/mp4" }] : []);
      const result = presentPackProject({ workspace: ctx.workspace, packId: "loam-video", kind: "video", artifacts, emit: ctx.emit });
      if (!result.ok) return { ok: false, content: JSON.stringify(result) };
      return json({ ...result, target: { kind: "loam-video", path: result.artifacts[0] } });
    }),
  ];
}
