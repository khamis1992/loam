// Workspace video editor routes: raw file GET/PUT, metadata/EDL hydration, render jobs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getTask } from "../db.js";
import { ensureTaskWorkspace, taskPath } from "../taskWorkspace.js";
import {
  cancelRender, ffmpegAvailable, normalizeEdl,
  probeVideo, startRender, streamVideoFile,
  getRenderJob, type VideoEdl, type VideoMeta,
} from "../workspace/videoRender.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes = 2_000_000): Promise<Record<string, unknown>> {
  const body = await readBody(req, maxBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface RouteContext { workspace: unknown }

function requireParams(url: URL): { taskId: string; rel: string } {
  const taskId = url.searchParams.get("taskId") ?? "";
  const rel = url.searchParams.get("path") ?? "";
  if (!taskId) throw new HttpError(400, "taskId required");
  if (!rel) throw new HttpError(400, "path required");
  return { taskId, rel };
}

function taskRoot(ctx: RouteContext | undefined, taskId: string): string {
  if (ctx == null || typeof ctx.workspace !== "string" || !ctx.workspace) throw new HttpError(500, "workspace root missing");
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, "task not found");
  return ensureTaskWorkspace(taskId, ctx.workspace);
}

/** Raw sibling file beside the source that holds the editor's EDL (e.g. clip.mp4.edl.json). */
function edlRelPath(rel: string): string {
  return `${rel}.edl.json`;
}

function savedEdl(root: string, rel: string, meta?: VideoMeta): VideoEdl | undefined {
  const abs = taskPath(root, edlRelPath(rel));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
    return normalizeEdl(parsed, meta?.duration);
  } catch { /* corrupt sidecar: fall back to a derived single clip */ }
  return undefined;
}

/** GET/PUT /api/workspace/video/file|meta|edl|hydrate, POST render, GET/DELETE render/:jobId. */
export async function handleWorkspaceVideoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  ctx: RouteContext | undefined = undefined,
): Promise<boolean> {
  const prefix = "/api/workspace/video";
  if (!rawPath.startsWith(prefix)) return false;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const p = url.pathname;
  try {
    // --- raw file bytes (video preview, EDL sidecar, any task file) ---
    if ((req.method === "GET" || req.method === "PUT") && (p === `${prefix}/file` || p === `${prefix}/edl`)) {
      const { taskId, rel } = requireParams(url);
      const root = taskRoot(ctx, taskId);
      if (req.method === "GET") {
        const target = p === `${prefix}/file` ? rel : edlRelPath(rel);
        const abs = taskPath(root, target);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, "file not found");
        if (p === `${prefix}/edl`) {
          const text = fs.readFileSync(abs, "utf8");
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
          res.end(text);
          return true;
        }
        streamVideoFile(req, res, abs);
        return true;
      }
      // PUT: save arbitrary bytes atomically; used for the EDL sidecar (onSave)
      const abs = taskPath(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const body = await readBody(req, 256_000_000);
      const staging = `${abs}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(staging, body);
      fs.renameSync(staging, abs);
      const st = fs.statSync(abs);
      sendJson(res, 200, { saved: rel, bytes: st.size, mtime: st.mtime.toISOString() });
      return true;
    }

    if (req.method === "GET" && p === `${prefix}/meta`) {
      const { taskId, rel } = requireParams(url);
      const root = taskRoot(ctx, taskId);
      const abs = taskPath(root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, "file not found");
      if (!ffmpegAvailable()) throw new HttpError(503, "ffmpeg is not available on this server");
      let probe: VideoMeta | undefined;
      try { probe = await probeVideo(abs); } catch { /* not a video or ffmpeg missing: give container facts only */ }
      const st = fs.statSync(abs);
      sendJson(res, 200, {
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        duration: probe?.duration,
        hasAudio: probe?.hasAudio,
      });
      return true;
    }

    if (req.method === "GET" && p === `${prefix}/hydrate`) {
      const { taskId, rel } = requireParams(url);
      const root = taskRoot(ctx, taskId);
      const abs = taskPath(root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, "file not found");
      if (!ffmpegAvailable()) throw new HttpError(503, "ffmpeg is not available on this server");
      let meta: VideoMeta | undefined;
      try { meta = await probeVideo(abs); } catch { /* fall through to a stub */ }
      const persisted = savedEdl(root, rel, meta);
      const edl = persisted ?? normalizeEdl({
        version: 1, clips: [{ id: "clip-1", in: 0, out: meta?.duration ?? 0 }], overlays: [],
      }, meta?.duration);
      const st = fs.statSync(abs);
      sendJson(res, 200, {
        edl,
        persisted: persisted != null,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        duration: meta?.duration,
        hasAudio: meta?.hasAudio,
      });
      return true;
    }

    if (req.method === "POST" && p === `${prefix}/render`) {
      const body = await readJsonBody(req);
      const taskId = typeof body.taskId === "string" ? body.taskId : "";
      const rel = typeof body.path === "string" ? body.path : "";
      if (!taskId || !rel) {
        sendJson(res, 400, { error: "taskId and path are required" });
        return true;
      }
      const root = taskRoot(ctx, taskId);
      const abs = taskPath(root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        sendJson(res, 404, { error: "source video not found" });
        return true;
      }
      let meta: VideoMeta | undefined;
      try { meta = await probeVideo(abs); } catch { /* render without an audio probe */ }
      let edl: VideoEdl;
      try {
        edl = normalizeEdl(body.edl, meta?.duration);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      if (edl.clips.length === 0) {
        sendJson(res, 400, { error: "at least one clip segment required" });
        return true;
      }
      const job = startRender(taskId, rel, edl, root, meta?.hasAudio ?? false);
      sendJson(res, 202, { jobId: job.id, status: job.status, progress: job.progress, output: job.output });
      return true;
    }

    const jobMatch = /^\/api\/workspace\/video\/render\/([^/]+)$/.exec(p);
    if (jobMatch && (req.method === "GET" || req.method === "DELETE")) {
      const id = decodeURIComponent(jobMatch[1]!);
      const job = getRenderJob(id);
      if (!job) {
        sendJson(res, 404, { error: "render job not found" });
        return true;
      }
      if (req.method === "DELETE") {
        const canceled = cancelRender(id);
        sendJson(res, 200, { canceled, status: getRenderJob(id)?.status });
        return true;
      }
      sendJson(res, 200, { ...job });
      return true;
    }

    sendJson(res, 404, { error: "unknown workspace video route" });
    return true;
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error("[workspace-video]", message);
    sendJson(res, status, { error: message });
    return true;
  }
}
