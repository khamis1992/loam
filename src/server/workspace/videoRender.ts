// Workspace video editor: EDL normalization + ffmpeg render jobs.
// Reuses the repo's canonical ffmpeg-static path (see src/creative/timeline.ts).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ROOT } from "../../config.js";
import { taskPath } from "../taskWorkspace.js";
import { getEntity, putEntity } from "../sqliteStore.js";

export const ffmpegPath = (): string =>
  path.join(ROOT, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

export function ffmpegAvailable(): boolean {
  try { return fs.statSync(ffmpegPath()).isFile(); } catch { return false; }
}

// ---------- EDL model ----------

export interface VideoEdlClip { id: string; in: number; out: number; }
export interface VideoEdlOverlay {
  id: string; text: string; start: number; end: number;
  /** Percent of frame width/height for the text anchor (0..99). */
  x?: number; y?: number;
}
export interface VideoEdl {
  version: 1;
  sourceDuration?: number;
  clips: VideoEdlClip[];
  overlays: VideoEdlOverlay[];
}

export const MIN_SEGMENT_SECONDS = 0.05;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function newId(): string {
  return crypto.randomUUID();
}

/** Validate + normalize an EDL from the editor. Throws on malformed input. */
export function normalizeEdl(input: unknown, sourceDuration?: number): VideoEdl {
  if (!input || typeof input !== "object") throw new Error("edl required");
  const raw = input as Record<string, unknown>;
  // Accept `segments` and start/end aliases so a task-produced EDL can hydrate too.
  const rawClips = Array.isArray(raw.clips) ? raw.clips : Array.isArray(raw.segments) ? raw.segments : raw.clips;
  if (!Array.isArray(rawClips)) throw new Error("edl.clips must be an array");
  const clips: VideoEdlClip[] = rawClips.map((c) => {
    if (!c || typeof c !== "object") throw new Error("invalid edl clip");
    const rec = c as Record<string, unknown>;
    const start = num(rec.in ?? rec.start);
    const end = num(rec.out ?? rec.end);
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("clip in/out must be finite numbers");
    let lo = Math.max(0, start);
    let hi = end;
    if (sourceDuration != null) {
      lo = Math.min(lo, Math.max(0, sourceDuration - MIN_SEGMENT_SECONDS));
      hi = Math.min(hi, sourceDuration);
    }
    if (hi - lo < MIN_SEGMENT_SECONDS) throw new Error("clip segment must be at least " + MIN_SEGMENT_SECONDS + "s");
    return { id: typeof rec.id === "string" && rec.id ? rec.id : newId(), in: lo, out: hi };
  });
  if (clips.length === 0) throw new Error("edl requires at least one clip segment");
  const rawOverlays = Array.isArray(raw.overlays) ? raw.overlays : [];
  const overlays: VideoEdlOverlay[] = rawOverlays.map((o) => {
    if (!o || typeof o !== "object") throw new Error("invalid edl overlay");
    const rec = o as Record<string, unknown>;
    const text = typeof rec.text === "string" ? rec.text.replace(/[\n\r]+/g, " ").trim() : "";
    if (!text) throw new Error("overlay text required");
    const start = num(rec.start);
    const end = num(rec.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end - start < MIN_SEGMENT_SECONDS) {
      throw new Error("overlay start/end must be finite numbers at least " + MIN_SEGMENT_SECONDS + "s apart");
    }
    const x = typeof rec.x === "number" && Number.isFinite(rec.x) ? Math.max(0, Math.min(99, rec.x)) : 10;
    const y = typeof rec.y === "number" && Number.isFinite(rec.y) ? Math.max(0, Math.min(99, rec.y)) : 10;
    return { id: typeof rec.id === "string" && rec.id ? rec.id : newId(), text, start, end, x, y };
  });
  return { version: 1, sourceDuration, clips, overlays };
}

export function edlDuration(edl: VideoEdl): number {
  return edl.clips.reduce((sum, c) => sum + (c.out - c.in), 0);
}

// ---------- video probing ----------

export interface VideoMeta { duration?: number; hasAudio: boolean; bytes: number; mtimeMs: number; }

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const AUDIO_RE = /^\s*Stream #0:\d+.*Audio:/m;

/** Probe a video with `ffmpeg -i` stderr; unknown duration stays undefined. */
export function probeVideo(absPath: string, executable = ffmpegPath()): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); } catch (err) { return reject(err); }
    let stderr = "";
    let settled = false;
    const child = spawn(executable, ["-hide_banner", "-i", absPath], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const finish = (fn: () => void) => { if (!settled) { settled = true; child.kill(); fn(); } };
    child.stderr?.on("data", (data: Buffer) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", () => finish(() => {
      const dur = DURATION_RE.exec(stderr);
      if (!dur) { return reject(new Error("could not read video duration; not a recognized video file?")); }
      const duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
      resolve({ duration, hasAudio: AUDIO_RE.test(stderr), bytes: stat.size, mtimeMs: stat.mtimeMs });
    }));
  });
}

// ---------- ffmpeg command construction ----------

const fmt = (n: number): string => n.toFixed(3);

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}

function drawtextFilters(edl: VideoEdl): string[] {
  return edl.overlays.map((o) =>
    `drawtext=text='${escapeDrawtext(o.text)}'` +
    ":fontcolor=white:fontsize=48:box=1:boxcolor=black@0.4:boxborderw=12" +
    `:x=w*${fmt(o.x ?? 10)}/100:y=h*${fmt(o.y ?? 10)}/100` +
    `:enable='between(t,${fmt(Math.max(0, o.start))},${fmt(o.end)})'`,
  );
}

/**
 * Build the full ffmpeg argv for one render. Pure so it is testable:
 * single input, per-clip trim chains concatenated, then overlays.
 * Overlays are positioned by frame percent so no font-size guess is made for the label.
 */
export function buildFfmpegArgs(edl: VideoEdl, sourceAbs: string, outAbs: string, hasAudio: boolean): string[] {
  const clips = edl.clips;
  const total = edlDuration(edl);
  // -progress keeps machine-readable progress on stderr even at loglevel error.
  const args: string[] = ["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:2", "-y", "-i", sourceAbs];

  const parts: string[] = [];
  const videoLabels = clips.map((_, i) => `v${i}`);
  const audioLabels = hasAudio ? clips.map((_, i) => `a${i}`) : [];
  clips.forEach((clip, i) => {
    parts.push(`[0:v]trim=start=${fmt(clip.in)}:end=${fmt(clip.out)},setpts=PTS-STARTPTS[${videoLabels[i]}]`);
    if (audioLabels.length) {
      parts.push(`[0:a]atrim=start=${fmt(clip.in)}:end=${fmt(clip.out)},asetpts=PTS-STARTPTS[${audioLabels[i]}]`);
    }
  });

  if (clips.length === 1 && edl.overlays.length === 0) {
    parts.push(`[${videoLabels[0]}]null[vOut]`);
    if (audioLabels.length) parts.push(`[${audioLabels[0]}]anull[aOut]`);
  } else {
    const n = clips.length;
    if (audioLabels.length) {
      // concat consumes inputs interleaved per segment: [v0][a0][v1][a1]...
      const interleaved = clips
        .map((_, i) => `[${videoLabels[i]}][${audioLabels[i]}]`)
        .join("");
      parts.push(`${interleaved}concat=n=${n}:v=1:a=1[vCat][aCat]`);
    } else {
      parts.push(videoLabels.map((l) => `[${l}]`).join("") + `concat=n=${n}:v=1:a=0[vCat]`);
    }
    const filters = drawtextFilters(edl);
    if (filters.length === 0) {
      parts.push("[vCat]null[vOut]");
    } else {
      let incoming = "[vCat]";
      filters.forEach((f, i) => {
        const target = i === filters.length - 1 ? "vOut" : `vT${i}`;
        parts.push(`${incoming}${f}[${target}]`);
        incoming = `[${target}]`;
      });
    }
    if (audioLabels.length) parts.push("[aCat]anull[aOut]");
  }

  args.push("-filter_complex", parts.join(";"), "-map", "[vOut]");
  if (audioLabels.length) args.push("-map", "[aOut]", "-c:a", "aac", "-b:a", "128k");
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-t", fmt(total),
    outAbs,
  );
  return args;
}

// ---------- request helpers used by the routes module ----------

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo", ".json": "application/json",
};

export function videoContentType(relOrAbsPath: string): string {
  return VIDEO_TYPES[path.extname(relOrAbsPath).toLowerCase()] ?? "application/octet-stream";
}

/** Streaming GET with byte ranges so HTML5 <video> can seek. */
export function streamVideoFile(req: IncomingMessage, res: ServerResponse, absPath: string): void {
  const stat = fs.statSync(absPath);
  const size = stat.size;
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("etag", `"${size}-${Math.round(stat.mtimeMs)}"`);
  const match = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range)) : undefined;
  if (match) {
    let start = match[1] ? Number(match[1]) : -1;
    let end = match[2] ? Number(match[2]) : size - 1;
    if (start < 0) start = size - Number(match[2]); // suffix range "bytes=-N"
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));
    res.writeHead(206, {
      "content-type": videoContentType(absPath),
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": videoContentType(absPath), "content-length": String(size) });
  fs.createReadStream(absPath).pipe(res);
}

// ---------- render jobs ----------

export type VideoJobStatus = "queued" | "running" | "done" | "error" | "canceled";

export interface VideoRenderJob {
  id: string;
  taskId: string;
  path: string;
  output: string;
  status: VideoJobStatus;
  progress: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, VideoRenderJob>();
const children = new Map<string, ChildProcess>();

const JOB_ENTITY = "workspace-video-job";

function persist(job: VideoRenderJob): void {
  job.updatedAt = Date.now();
  putEntity(JOB_ENTITY, job);
}

export function getRenderJob(id: string): VideoRenderJob | undefined {
  const live = jobs.get(id);
  if (live) return live;
  const stored = getEntity<VideoRenderJob>(JOB_ENTITY, id);
  if (stored && (stored.status === "running" || stored.status === "queued")) {
    // A job left running by a previous server process died with it.
    stored.status = "error";
    stored.error ??= "render interrupted by restart";
  }
  if (stored) jobs.set(id, stored);
  return stored;
}

/** Pick a non-colliding rendered-output path beside the source, inside the task workspace. */
export function chooseOutputPath(relSource: string, taskRoot: string): string {
  taskPath(taskRoot, relSource);
  const dir = path.dirname(relSource) === "." ? "" : path.dirname(relSource);
  const base = path.basename(relSource, path.extname(relSource));
  for (let n = 1; n < 1000; n++) {
    const rel = path.join(dir, `${base}.edit${n === 1 ? "" : "-" + n}.mp4`);
    if (!fs.existsSync(taskPath(taskRoot, rel))) return rel;
  }
  throw new Error("too many rendered files; clean up the task folder");
}

const TIME_RE = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const PROGRESS_RE = /out_time_ms=(\d+)/g;

/** Recover the rendered offset from `-progress pipe:2` (fallback: a stats line). */
export function parseProgress(stderr: string): number | undefined {
  const matches = [...stderr.matchAll(PROGRESS_RE)];
  const last = matches.at(-1);
  if (last) return Number(last[1]) / 1_000_000;
  const m = TIME_RE.exec(stderr);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

interface QueuedRender {
  job: VideoRenderJob;
  edl: VideoEdl;
  hasAudio: boolean;
  sourceAbs: string;
  outAbs: string;
}

const pending: QueuedRender[] = [];
let running: QueuedRender | undefined;

/**
 * ffmpeg renders are serialized (at most one child at a time) so parallel
 * editor tabs do not thrash the CPU. Queue order is FIFO.
 */
export function startRender(
  taskId: string, relSource: string, edl: VideoEdl, taskRoot: string, hasAudio: boolean,
): VideoRenderJob {
  if (!ffmpegAvailable()) throw new Error("ffmpeg is not installed for this build");
  const sourceAbs = taskPath(taskRoot, relSource);
  if (!fs.statSync(sourceAbs).isFile()) throw new Error("source video not found");
  const output = chooseOutputPath(relSource, taskRoot);
  const job: VideoRenderJob = {
    id: crypto.randomUUID(), taskId, path: relSource, output,
    status: "queued", progress: 0, createdAt: Date.now(), updatedAt: Date.now(),
  };
  persist(job);
  jobs.set(job.id, job);
  pending.push({ job, edl, hasAudio, sourceAbs, outAbs: taskPath(taskRoot, output) });
  void drain();
  return job;
}

async function drain(): Promise<void> {
  if (running) return;
  const item = pending.shift();
  if (!item) return;
  running = item;
  item.job.status = "running";
  item.job.progress = 2;
  persist(item.job);
  try {
    await runFfmpeg(item);
  } finally {
    if (running?.job.id === item.job.id) running = undefined;
    void drain();
  }
}

function runFfmpeg(item: QueuedRender): Promise<void> {
  const { job, edl, sourceAbs } = item;
  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = "";
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      children.delete(job.id);
      if (job.status === "running") {
        if (!error) {
          job.status = fs.existsSync(item.outAbs) ? "done" : "error";
          job.progress = 100;
          if (job.status === "error") job.error = "ffmpeg output file missing";
        } else {
          job.status = "error";
          job.error = error;
        }
      } else if (job.status === "canceled" && fs.existsSync(item.outAbs)) {
        job.status = "done";
        job.progress = 100;
      }
      persist(job);
      resolve();
    };
    const child = spawn(ffmpegPath(), buildFfmpegArgs(edl, sourceAbs, item.outAbs, item.hasAudio), {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    children.set(job.id, child);
    child.stderr?.on("data", (data: Buffer) => {
      stderrTail = (stderrTail + data).slice(-4000);
      const t = parseProgress(stderrTail);
      if (t != null && job.status === "running") {
        const total = edlDuration(edl);
        if (total > 0) {
          job.progress = Math.max(2, Math.min(96, Math.round((t / total) * 94) + 2));
          persist(job);
        }
      }
    });
    child.on("error", (err) => finish(String(err)));
    child.on("exit", (code) => finish(code === 0 ? undefined : `ffmpeg failed: ${(stderrTail || `exit code ${code}`).slice(-400)}`));
  });
}

export function cancelRender(id: string): boolean {
  const job = getRenderJob(id);
  if (!job) return false;
  if (job.status === "queued") {
    const idx = pending.findIndex((p) => p.job.id === id);
    if (idx >= 0) pending.splice(idx, 1);
    job.status = "canceled";
    persist(job);
    return true;
  }
  if (job.status === "running") {
    const child = children.get(id);
    child?.kill();
    children.delete(id);
    if (job.status === "running") job.status = "canceled";
    persist(job);
    if (running?.job.id === id) running = undefined;
    return true;
  }
  return false;
}
