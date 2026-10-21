// Transcript routes: transcribe a task-workspace media asset, then edit by
// transcript (delete words/sentences, remove filler words) into EDL cuts.
// Transcription reuses the local STT server path (scripts/stt_server.py via
// LOAM_STT_URL); editing logic is pure TypeScript in src/creative/transcript.ts.
import http from "node:http";
import fs from "node:fs";
import {
  transcribe,
  transcriptWords,
  buildEdl,
  deleteWords,
  deleteSegments,
  removeFillerWords,
  type Transcript,
} from "../../creative/transcript.js";
import { getTask } from "../db.js";
import { requireTaskWorkspace, taskPath } from "../taskWorkspace.js";
import { getLoamMode } from "../../modes/catalog.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 4_000_000): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
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
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch (err) {
        reject(new Error("invalid JSON body: " + (err instanceof Error ? err.message : String(err))));
      }
    });
    req.on("error", reject);
  });
}

function mediaRoot(ctx: { workspace?: string } | undefined, taskId: unknown): string {
  if (!ctx || typeof ctx.workspace !== "string" || !ctx.workspace) throw new Error("workspace context missing");
  const task = getTask(String(taskId));
  if (!task) throw new Error("task not found");
  if (getLoamMode(task.mode).id !== "media") throw new Error("transcript editing requires a media task");
  return requireTaskWorkspace(taskId, ctx.workspace);
}

/** Media assets accepted by the editor are the same timeline asset uploads. */
function resolveMedia(root: string, input: unknown): string {
  if (typeof input !== "string" || !/^assets\/timeline\/[a-f\d-]+\.(png|jpg|webp|mp4|webm|mp3|wav|ogg|m4a)$/i.test(input)) {
    throw new Error("invalid media path");
  }
  const file = taskPath(root, input);
  fs.accessSync(file);
  return file;
}

export async function handleTranscriptRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p !== "/api/creative/transcribe" && p !== "/api/creative/transcript-edit") return false;
  try {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` || req.headers["sec-fetch-site"] === "cross-site") {
      sendJson(res, 403, { error: "Same-origin required" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }

    // POST /api/creative/transcribe  {taskId, path} -> {transcript, words}
    if (p === "/api/creative/transcribe") {
      const body = await readJson(req);
      const root = mediaRoot(ctx as { workspace?: string } | undefined, body.taskId);
      const media = resolveMedia(root, body.path);
      const transcript = await transcribe(media);
      sendJson(res, 200, { transcript, words: transcriptWords(transcript) });
      return true;
    }

    // POST /api/creative/transcript-edit
    //   body: {taskId, transcript: Transcript, edit: {kind:"words", indices:number[]} |
    //          {kind:"segments", indices:number[]} | {kind:"range", start,end} | {kind:"fillers", extraWords?:string[], maxDurationSeconds?:number}}
    //   -> {count, removed, cuts, keeps, textAfter} (EDL over the source timeline)
    if (p === "/api/creative/transcript-edit") {
      const body = await readJson(req);
      mediaRoot(ctx as { workspace?: string } | undefined, body.taskId); // guarded, the transcript is caller-supplied JSON
      const transcript = body.transcript as Transcript | undefined;
      const edit = body.edit as { kind?: unknown; indices?: unknown; start?: unknown; end?: unknown; extraWords?: unknown; maxDurationSeconds?: unknown } | undefined;
      if (!transcript || !Array.isArray(transcript.segments)) throw new Error("transcript with segments is required");
      if (!edit || typeof edit.kind !== "string") throw new Error("edit kind is required");
      if (typeof transcript.duration !== "number" || !Number.isFinite(transcript.duration)) throw new Error("transcript duration is required");
      const indices = Array.isArray(edit.indices) ? edit.indices.filter((x) => Number.isInteger(x) && Number(x) >= 0).map(Number) : [];
      let result: { count: number; removed: number; cuts: unknown; keeps: unknown; textAfter: string };
      if (edit.kind === "words") {
        if (!indices.length) throw new Error("word indices are required");
        const edl = deleteWords(transcript, indices);
        result = { count: indices.length, removed: edl.removed, cuts: edl.cuts, keeps: edl.keeps, textAfter: edl.textAfter };
      } else if (edit.kind === "segments") {
        if (!indices.length) throw new Error("segment indices are required");
        const edl = deleteSegments(transcript, indices);
        result = { count: indices.length, removed: edl.removed, cuts: edl.cuts, keeps: edl.keeps, textAfter: edl.textAfter };
      } else if (edit.kind === "range") {
        const s = Number(edit.start), e = Number(edit.end);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error("range start/end are required");
        const built = buildEdl(transcript, [{ start: s, end: e }]);
        result = { count: built.cuts.length, removed: built.removed, cuts: built.cuts, keeps: built.keeps, textAfter: built.textAfter };
      } else if (edit.kind === "fillers") {
        const removal = removeFillerWords(transcript, {
          ...(Array.isArray(edit.extraWords) ? { extraWords: edit.extraWords.filter((x) => typeof x === "string") as string[] } : {}),
          ...(typeof edit.maxDurationSeconds === "number" && edit.maxDurationSeconds > 0 ? { maxDurationSeconds: edit.maxDurationSeconds } : {}),
        });
        result = { count: removal.count, removed: removal.edl.removed, cuts: removal.edl.cuts, keeps: removal.edl.keeps, textAfter: removal.edl.textAfter };
      } else throw new Error("unknown edit kind");
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 404, { error: "Not found" });
    return true;
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
