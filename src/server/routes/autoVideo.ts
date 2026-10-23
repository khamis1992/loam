/**
 * V4: /api/auto-video routes over the clean-room auto helpers (src/creative/auto.ts).
 * NOTICE: feature set references design ideas from Rakazo's Apache-2.0 "FilmCraft"
 * pipeline; this is an original TypeScript implementation with no copied code/assets.
 *
 * Scene + energy lanes run through a real ffmpeg-static probe; subject boxes and
 * transcripts are accepted as structured inputs so the STT/ML lanes stay pluggable.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {ROOT, rootAsset} from "../../config.js";
import {getTask} from "../db.js";
import {taskPath} from "../taskWorkspace.js";
import {planAutoEdit, parseSceneLog, parseLoudnessLog, type AutoEditOptions, type MediaProbe, type TranscriptSegment} from "../../creative/auto.js";

const frameFps=4;
const ffmpegExecutable=rootAsset("node_modules", "ffmpeg-static",process.platform==="win32"?"ffmpeg.exe":"ffmpeg");

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable, ["-hide_banner", ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => { settled = true; child.kill(); reject(new Error("ffmpeg timed out")); }, timeoutMs);
    child.stdout?.on("data", d => { stdout = (stdout + d).slice(-4_000_000); });
    child.stderr?.on("data", d => { stderr = (stderr + d).slice(-200_000); });
    child.once("error", e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.once("exit", code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error("ffmpeg failed: " + (stderr.split("\n").filter(Boolean).at(-1) ?? "unknown error")));
    });
  });
}

/** ffmpeg-static lane for visual cuts and loudness; other lanes stay pluggable inputs. */
function buildProbe(): MediaProbe {
  return {
    async frameDiffs(file) {
      const {stdout} = await runFfmpeg(["-i", file, "-vf", `fps=${frameFps},select='gte(scene,0)',metadata=mode=print:file=-`, "-an", "-f", "null", "-"], 300_000);
      return parseSceneLog(stdout);
    },
    async audioEnergy(file) {
      const {stderr} = await runFfmpeg(["-i", file, "-af", "ebur128=metadata=1", "-vn", "-f", "null", "-"], 300_000);
      return parseLoudnessLog(stderr);
    },
  };
}

// The probe lanes reuse the pure parsers from auto.ts so fixtures and live runs share logic.

const num = (o: Record<string, unknown>, key: string): number | undefined =>
  typeof o[key] === "number" && Number.isFinite(o[key] as number) ? (o[key] as number) : undefined;

/** Numeric options are validated/clamped here; anything else is dropped, never trusted. */
export function sanitizeOptions(raw: Record<string, unknown>): AutoEditOptions {
  const o: AutoEditOptions = {};
  const threshold = num(raw, "threshold"); if (threshold !== undefined && threshold >= 0 && threshold <= 1) o.threshold = threshold;
  const minSceneSeconds = num(raw, "minSceneSeconds"); if (minSceneSeconds !== undefined && minSceneSeconds >= 0) o.minSceneSeconds = minSceneSeconds;
  const duration = num(raw, "duration"); if (duration !== undefined && duration > 0) o.duration = duration;
  const targetSeconds = num(raw, "targetSeconds"); if (targetSeconds !== undefined && targetSeconds > 0) o.targetSeconds = targetSeconds;
  const minClipSeconds = num(raw, "minClipSeconds"); if (minClipSeconds !== undefined && minClipSeconds > 0) o.minClipSeconds = minClipSeconds;
  const maxClipSeconds = num(raw, "maxClipSeconds"); if (maxClipSeconds !== undefined && maxClipSeconds > 0) o.maxClipSeconds = maxClipSeconds;
  const aspect = num(raw, "aspect"); if (aspect !== undefined && aspect > 0) o.aspect = aspect;
  const width = num(raw, "width"); if (width !== undefined && width >= 1 && width <= 16384) o.width = Math.round(width);
  const height = num(raw, "height"); if (height !== undefined && height >= 1 && height <= 16384) o.height = Math.round(height);
  const maxChars = num(raw, "maxChars"); if (maxChars !== undefined && maxChars >= 1 && maxChars <= 200) o.maxChars = Math.round(maxChars);
  const maxCueSeconds = num(raw, "maxCueSeconds"); if (maxCueSeconds !== undefined && maxCueSeconds >= 0.2 && maxCueSeconds <= 30) o.maxCueSeconds = maxCueSeconds;
  if (typeof raw.language === "string") o.language = raw.language.slice(0, 16);
  if (Array.isArray(raw.transcript)) o.transcript = raw.transcript as TranscriptSegment[];
  if (Array.isArray(raw.subjects)) o.subjects = raw.subjects as AutoEditOptions["subjects"];
  return o;
}

/** Auto-video plan routes: /api/auto-video/environment and /api/auto-video/plan. */
export async function handleAutoVideoRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/auto-video/")) return false;
  try {
    if (p === "/api/auto-video/environment" && req.method === "GET") {
      sendJson(res, 200, { ffmpegAvailable: fs.existsSync(ffmpegExecutable), frameFps });
      return true;
    }
    if (p === "/api/auto-video/plan" && req.method === "POST") {
      const input = await readJson(req);
      if (typeof input.taskId !== "string" || typeof input.path !== "string" || !/^assets\/timeline\/[a-f\d-]+\.(mp4|webm|mov|m4v)$/.test(input.path)) {
        sendJson(res, 400, { error: "taskId and assets/timeline video path are required" });
        return true;
      }
      const task = getTask(input.taskId);
      if (task?.mode !== "media" || !task.workspace) { sendJson(res, 400, { error: "task must be a media task with a workspace" }); return true; }
      if (!fs.existsSync(ffmpegExecutable)) { sendJson(res, 400, { error: "ffmpeg is not available on this machine" }); return true; }
      const file = taskPath(task.workspace, input.path);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) { sendJson(res, 400, { error: "asset not found in the task workspace" }); return true; }
      if (stat.size > 2 * 1024 * 1024 * 1024) { sendJson(res, 400, { error: "asset exceeds the 2 GB probe limit" }); return true; }
      const options = sanitizeOptions((input.options && typeof input.options === "object" && !Array.isArray(input.options)) ? input.options as Record<string, unknown> : {});
      const plan = await planAutoEdit(file, options, buildProbe());
      sendJson(res, 200, plan);
      return true;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  return true;
}
