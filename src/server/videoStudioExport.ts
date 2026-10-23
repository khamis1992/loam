/**
 * fc-06 — Loam Video export-to-task-files service.
 *
 * One implementation, two entry points (the `video_studio` agent tool and the
 * panel's Export button via `POST /api/tasks/:id/video-studio/export`). The flow:
 *
 *   resolve the real export command id from the live editor catalog
 *     -> `execute` the export (waiting for the render job)
 *     -> `readFile` the rendered bytes out of the editor's virtual FS
 *     -> atomically write them into `<taskRoot>/exports/<name>`
 *     -> report the relative path, name and mime so the caller can link it
 *
 * Why a service and not an inline action: the export needs several round trips
 * (catalog, execute, job poll, read), progress reporting and a real file write.
 * Keeping it here means the tool and the HTTP route cannot drift, and both stay
 * thin. The editor still owns every render decision — this module only never
 * guesses a command id, always resolving it against `commands()` first.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publishTaskEvent } from "./streams.js";
import { taskPath } from "./taskWorkspace.js";
import {
  closeMatches,
  resolveCommandId,
  toCommandIdList,
  VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES,
} from "../tools/videoStudio.js";

// ---------------------------------------------------------------------------
// Relay contract (structural, so tests can inject a mock)
// ---------------------------------------------------------------------------

export type VideoStudioExportTarget = "film" | "effects";

/** Minimal relay surface the export needs (the real VideoStudioRelay satisfies it). */
export interface VideoStudioExportRelay {
  enqueue(
    taskId: string,
    target: VideoStudioExportTarget,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VideoStudioExportQuality = "low" | "medium" | "high" | "best";

/** What the caller asked the editor to render. */
export interface VideoStudioExportOptions {
  /** Container/format, default mp4. Common aliases are normalised. */
  format?: string;
  name?: string;
  /** Output path inside the editor's virtual FS (defaults to /exports/<name>). */
  path?: string;
  width?: number;
  height?: number;
  quality?: VideoStudioExportQuality;
  /** Target video bitrate in kbit/s; overrides the quality hint. */
  bitrateKbps?: number;
  range?: "entire" | "inOut" | "workArea" | "custom";
  startSeconds?: number;
  endSeconds?: number;
}

/** Progress callback payloads (published live and handed to `onProgress`). */
export type VideoStudioExportProgress =
  | { stage: "starting" }
  | { stage: "rendering"; progress: number }
  | { stage: "saving" };

export interface VideoStudioExportResult {
  ok: true;
  /** Path relative to the task workspace, POSIX separators (exports/<name>). */
  path: string;
  name: string;
  mime: string;
  bytes: number;
  /** The engine command id that actually rendered (resolved from the catalog). */
  command: string;
}

// ---------------------------------------------------------------------------
// Command-id resolution
// ---------------------------------------------------------------------------

/**
 * Export command ids, most-likely-first. The single definition lives in
 * `src/tools/videoStudio.ts` and is imported (not redeclared) here, so the tool
 * and the HTTP route can never resolve different ids. Re-exported for callers
 * that read the service's surface.
 */
export { VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES };

/** Job/queue command ids used to wait for a queued render. */
export const VIDEO_STUDIO_JOB_COMMAND_CANDIDATES = ["jobs.poll", "jobs.list", "status.job.progress", "progress.job"] as const;

// ---------------------------------------------------------------------------
// Format handling
// ---------------------------------------------------------------------------

/** Container aliases normalised to a canonical extension (lowercase, no dot). */
const FORMAT_ALIASES: Record<string, string> = {
  mp4: "mp4",
  m4v: "m4v",
  mov: "mov",
  quicktime: "mov",
  qt: "mov",
  webm: "webm",
  mkv: "mkv",
  matroska: "mkv",
  avi: "avi",
  mxf: "mxf",
  ogg: "ogg",
  ogv: "ogv",
  wav: "wav",
  wave: "wav",
  mp3: "mp3",
  mpeg: "mp3",
  aac: "aac",
  m4a: "m4a",
  flac: "flac",
  oga: "oga",
  opus: "opus",
  png: "png",
  jpg: "jpg",
  jpeg: "jpeg",
  tif: "tif",
  tiff: "tiff",
  exr: "exr",
  gif: "gif",
};

/** Supported format labels, for error messages and the tool description. */
export const VIDEO_STUDIO_EXPORT_FORMATS = [
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
  "avi",
  "mxf",
  "wav",
  "mp3",
  "aac",
  "flac",
  "png",
  "jpeg",
  "tiff",
  "exr",
] as const;

/** Default container. */
export const VIDEO_STUDIO_DEFAULT_FORMAT = "mp4";

/**
 * Normalise a requested format to a canonical extension.
 * Throws with the supported list when the format is unknown: an export to an
 * invented extension would silently fail inside the editor.
 */
export function normalizeExportFormat(format: unknown): string {
  const raw = typeof format === "string" ? format.trim().toLowerCase().replace(/^\./, "") : "";
  if (!raw) return VIDEO_STUDIO_DEFAULT_FORMAT;
  const canonical = FORMAT_ALIASES[raw];
  if (canonical) return canonical;
  throw new Error(
    `Unsupported Loam Video export format "${raw}". Supported formats: ${VIDEO_STUDIO_EXPORT_FORMATS.join(", ")}.`,
  );
}

/** Media type for an export name or format (audio containers still carry audio). */
export function mimeForExport(nameOrFormat: string): string {
  const ext = (nameOrFormat.split(".").pop() ?? "").toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "mp4":
    case "m4v":
    case "m4p":
    case "m4b":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "mxf":
      return "application/mxf";
    case "ogg":
    case "ogv":
      return "video/ogg";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "aac":
      return "audio/aac";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "oga":
      return "audio/ogg";
    case "opus":
      return "audio/ogg";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "exr":
      return "image/x-exr";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

// ---------------------------------------------------------------------------
// Name sanitising
// ---------------------------------------------------------------------------

/** Characters allowed in an export file name: letters, numbers, space, dot, dash. */
const SAFE_NAME_CHAR = /[^\p{L}\p{N}_ .\-]/gu;

/** Leading path traversal components (`.`/`..` followed by a separator). */
const TRAVERSAL_PREFIX = /^(?:\.?\.?[\\/])+/;

/** Dot run (`.`, `..`, `...`), which carries no meaning in a single file name. */
const DOT_RUN = /\.{2,}/g;

/**
 * Build a safe file name: keep the caller's intent (including Arabic), neutralise
 * traversal and path separators, force the canonical extension and fall back to a
 * timestamped default when nothing usable remains.
 *
 * A leading traversal is stripped outright and every remaining separator becomes a
 * dash, so `../../etc/passwd` becomes `etc-passwd` (never the leading-dot
 * `etcpasswd` no shell or web app would serve) and `a/b\\c:d*e?f` becomes
 * `a-b-cdef`. The result is always a single path segment, so it can never escape
 * the exports directory.
 */
export function sanitizeExportName(raw: unknown, format: string): string {
  const wanted = typeof raw === "string" ? raw.trim() : "";
  const cleaned = wanted
    .replace(TRAVERSAL_PREFIX, "")
    .replace(/[\\/]/g, "-")
    .replace(SAFE_NAME_CHAR, "")
    .replace(DOT_RUN, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 96)
    .replace(/[.\-]+$/, "");
  if (cleaned) return `${cleaned}.${format}`;
  return `loam-video-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${format}`;
}

// ---------------------------------------------------------------------------
// Editor params
// ---------------------------------------------------------------------------

/** Editor virtual-FS root for rendered exports. */
export const EXPORT_DIR = "/exports";

/** Build the engine params for one export (no invented settings keys). */
export function buildExportParams(
  options: VideoStudioExportOptions,
  virtualPath: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    path: virtualPath,
    range: options.range ?? "entire",
    // The editor defaults `wait` to false (fire-and-forget); this flow always
    // needs the rendered file, so it waits and the job is polled for progress.
    wait: true,
  };
  if (Number.isFinite(options.width)) params["width"] = Math.max(1, Math.round(options.width as number));
  if (Number.isFinite(options.height)) params["height"] = Math.max(1, Math.round(options.height as number));
  if (Number.isFinite(options.bitrateKbps)) {
    params["targetKbps"] = Math.max(1, Math.round(options.bitrateKbps as number));
  } else if (options.quality) {
    // Quality is a bitrate hint, expressed as the editor's own targetKbps key.
    params["targetKbps"] = QUALITY_BITRATE_KBPS[options.quality];
  }
  if (options.range === "custom") {
    if (Number.isFinite(options.startSeconds)) params["startSeconds"] = options.startSeconds;
    if (Number.isFinite(options.endSeconds)) params["endSeconds"] = options.endSeconds;
  }
  return params;
}

const QUALITY_BITRATE_KBPS: Record<VideoStudioExportQuality, number> = {
  low: 2_500,
  medium: 6_000,
  high: 12_000,
  best: 24_000,
};

// ---------------------------------------------------------------------------
// Byte normalisation
// ---------------------------------------------------------------------------

/**
 * Accept the many shapes `readFile` can return (base64 string, data URL,
 * `{data|base64|bytes|buffer|contents}`, ArrayBuffer, typed array or a legacy
 * byte-indexed object) and produce real bytes.
 */
export function normalizeExportBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("the editor returned an empty file (no bytes)");
    const dataUrl = /^data:[^,]*,([\s\S]*)$/i.exec(trimmed);
    return Buffer.from(dataUrl ? dataUrl[1]! : trimmed, "base64");
  }

  if (Array.isArray(value)) {
    return Buffer.from(value.map((entry) => Number(entry) & 0xff));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["buffer", "bytes", "base64", "data", "contents", "content"]) {
      const inner = record[key];
      if (Buffer.isBuffer(inner)) return inner;
      if (inner instanceof ArrayBuffer) return Buffer.from(new Uint8Array(inner));
      if (ArrayBuffer.isView(inner)) return Buffer.from(inner.buffer, inner.byteOffset, inner.byteLength);
      if (typeof inner === "string") {
        const text = inner.trim();
        if (!text) continue;
        const dataUrl = /^data:[^,]*,([\s\S]*)$/i.exec(text);
        return Buffer.from(dataUrl ? dataUrl[1]! : text, "base64");
      }
      if (Array.isArray(inner)) return Buffer.from(inner.map((entry) => Number(entry) & 0xff));
    }
    // Legacy byte-indexed object ({0: 137, 1: 80, ...}).
    const keys = Object.keys(record).filter((key) => /^\d+$/.test(key));
    if (keys.length > 0) {
      const max = Math.max(...keys.map(Number));
      const out = Buffer.alloc(max + 1);
      for (const key of keys) out[Number(key)] = Number(record[key]) & 0xff;
      return out;
    }
  }

  throw new Error(
    `the editor returned export bytes in an unrecognised shape (${typeof value}); re-read the file with readFile and pass a base64 string`,
  );
}

// ---------------------------------------------------------------------------
// Job handling
// ---------------------------------------------------------------------------

/** True for job states that mean the render is done and the file exists. */
const DONE_STATES = new Set(["done", "finished", "complete", "completed", "succeeded", "success", "ok"]);
/** True for job states that mean the render will never produce a file. */
const FAILED_STATES = new Set(["failed", "error", "cancelled", "canceled", "aborted"]);

/** Read a progress fraction (0..1) from any of the keys an editor may use. */
function readProgress(record: Record<string, unknown>): number | null {
  for (const key of ["progress", "percent", "pct", "fraction", "percentComplete"]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw <= 1 ? raw : raw / 100;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed <= 1 ? parsed : parsed / 100;
    }
  }
  return null;
}

/** Read a status string from a job record. */
function readStatus(record: Record<string, unknown>): string | null {
  for (const key of ["status", "state", "phase"]) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim().toLowerCase();
  }
  return null;
}

/** Pull the first job-like record out of a poll/list result. */
function firstJob(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const entry of value) if (entry && typeof entry === "object") return entry as Record<string, unknown>;
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["job", "item", "export"]) {
      const inner = record[key];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
    }
    for (const key of ["jobs", "items", "exports", "queue"]) {
      const list = record[key];
      if (Array.isArray(list)) {
        for (const entry of list) if (entry && typeof entry === "object") return entry as Record<string, unknown>;
      }
    }
    // A bare record that carries a status/progress of its own is the job.
    if (readStatus(record) || readProgress(record) !== null) return record;
  }
  return null;
}

/** Pull the produced file path out of a result or job record. */
export function outputPathFromResult(value: unknown, fallback: string): string {
  const candidates: unknown[] = [value];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["job", "item", "result", "export"]) {
      const inner = record[key];
      if (inner && typeof inner === "object") candidates.push(inner);
    }
    for (const key of ["jobs", "items", "exports", "files", "queue"]) {
      const list = record[key];
      if (Array.isArray(list)) candidates.push(...list);
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    for (const key of ["path", "output", "outputPath", "destination", "file", "filePath", "uri", "url"]) {
      const raw = record[key];
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Export flow
// ---------------------------------------------------------------------------

export interface VideoStudioExportContext {
  taskId: string;
  /** Relay used to reach the editor panel. */
  relay: VideoStudioExportRelay;
  /** Task workspace root the rendered file is written into. */
  taskRoot: string;
  options?: VideoStudioExportOptions;
  /** Called for every stage change; also published on the task stream. */
  onProgress?: (progress: VideoStudioExportProgress) => void;
  /** Injectable clock/interval so tests stay deterministic. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Max time to wait for the render (default 600s). */
  timeoutMs?: number;
  /** Poll interval while waiting (default 500ms). */
  pollIntervalMs?: number;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

function emitProgress(context: VideoStudioExportContext, progress: VideoStudioExportProgress): void {
  try {
    context.onProgress?.(progress);
  } catch {
    /* a progress callback must never break the export */
  }
  try {
    publishTaskEvent(context.taskId, {
      type: "video_studio_export",
      taskId: context.taskId,
      stage: progress.stage,
      ...(progress.stage === "rendering" ? { progress: progress.progress } : {}),
    });
  } catch {
    /* publishing is best-effort */
  }
}

function raise(message: string): never {
  throw new Error(message);
}

/** Run the export and write the rendered file into the task workspace. */
export async function runVideoStudioExport(
  context: VideoStudioExportContext,
): Promise<VideoStudioExportResult> {
  const { taskId, relay, taskRoot } = context;
  const options = context.options ?? {};
  const now = context.now ?? (() => Date.now());
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = context.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const pollIntervalMs = context.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const format = normalizeExportFormat(options.format);
  const name = sanitizeExportName(options.name, format);
  const virtualPath = options.path?.trim() || `${EXPORT_DIR}/${name}`;
  const params = buildExportParams(options, virtualPath);

  // 1. Resolve the export command id from the live catalog (never guess).
  emitProgress(context, { stage: "starting" });
  const catalogRaw = await relay.enqueue(taskId, "film", "commands", {});
  const catalog = toCommandIdList(catalogRaw);
  const command = resolveCommandId(catalog, VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES);
  if (!command) {
    const matches = closeMatches(catalog, VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES[0]!).slice(0, 5);
    raise(
      `This Loam Video build exposes no export command (looked for: ${VIDEO_STUDIO_EXPORT_COMMAND_CANDIDATES.join(", ")}).` +
        (matches.length > 0 ? ` Close matches: ${matches.join(", ")}.` : "") +
        (catalog.length > 0 ? ` Available commands: ${catalog.slice(0, 40).join(", ")}.` : " The editor returned no command list."),
    );
  }

  // 2. Run the export. `wait` is true, so the editor blocks until it finishes
  //    and reports the produced file; if it returns a queued job we poll it.
  const executed = await relay.enqueue(taskId, "film", "execute", { command, params });
  let outputPath = outputPathFromResult(executed, virtualPath);
  let job = firstJob(executed);

  if (job) {
    let status = readStatus(job);
    const deadline = now() + timeoutMs;
    const jobCommand = resolveCommandId(catalog, VIDEO_STUDIO_JOB_COMMAND_CANDIDATES);
    while (status && !DONE_STATES.has(status) && !FAILED_STATES.has(status)) {
      const progress = readProgress(job);
      if (progress !== null) {
        emitProgress(context, { stage: "rendering", progress: Math.min(1, Math.max(0, progress)) });
      }
      if (now() >= deadline) raise(`the Loam Video export did not finish within ${Math.round(timeoutMs / 1000)}s`);
      await sleep(pollIntervalMs);
      // Resolve the poll command from the same live catalog we already read, so
      // an editor that spells it differently is followed instead of being polled
      // through a command id it never exposed. If it exposes none, keep the
      // leading candidate rather than guessing on every iteration.
      const polled = await relay.enqueue(taskId, "film", "execute", {
        command: jobCommand ?? VIDEO_STUDIO_JOB_COMMAND_CANDIDATES[0]!,
        params: {},
      });
      job = firstJob(polled);
      if (!job) break;
      status = readStatus(job);
      const path = outputPathFromResult(job, "");
      if (path) outputPath = path;
    }
    if (status && FAILED_STATES.has(status)) {
      const detail =
        [job?.["error"], job?.["message"], job?.["reason"]].find((entry) => typeof entry === "string" && entry.trim()) ??
        "the render failed";
      raise(`the Loam Video export failed (${String(detail).trim()})`);
    }
    const finishedPath = outputPathFromResult(job, "");
    if (finishedPath) outputPath = finishedPath;
  }

  // 3. Read the bytes back out of the editor's virtual FS.
  let raw: unknown;
  try {
    raw = await relay.enqueue(taskId, "film", "readFile", { path: outputPath });
  } catch {
    raw = await relay.enqueue(taskId, "film", "readFile", { file: outputPath });
  }
  const bytes = normalizeExportBytes(raw);
  if (bytes.length === 0) raise(`the Loam Video export produced an empty file at ${outputPath}`);

  // 4. Write atomically into the task workspace (staging + rename).
  emitProgress(context, { stage: "saving" });
  const relative = path.posix.join("exports", name);
  const abs = taskPath(taskRoot, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const staging = `${abs}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staging, bytes);
    fs.renameSync(staging, abs);
  } catch (error) {
    try { fs.rmSync(staging, { force: true }); } catch { /* ignore */ }
    throw error;
  }

  return { ok: true, path: relative, name, mime: mimeForExport(name), bytes: bytes.length, command };
}
