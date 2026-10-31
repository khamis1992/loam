/** د3 — collaboration routes over the doc track model: join / SSE stream /
 *  op / leave. Same-origin + token auth come from the global http.ts gate;
 *  persistence flows through the existing track sidecar (docTrackIO).
 *
 *  XSS note (reviewer): this is a JSON/SSE API — no HTML is produced. All
 *  response bodies are JSON.stringify'd strings sent with an explicit
 *  application/json or text/event-stream content type, and SSE payloads are
 *  single-line JSON (JSON.stringify collapses newlines), so no markup context
 *  exists for injection.
 */
import http from "node:http";
import path from "node:path";
import { collabRooms, type CollabOp, type TrackedDocument } from "../collab/rooms.js";
import { loadDocTrack, saveDocTrack, assertTrackPayload } from "../workspace/docTrackIO.js";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { getSettings } from "../settings.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 200_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function fail(res: http.ServerResponse, status: number, code: string): void {
  sendJson(res, status, { error: code });
}

/** Resolve a collab target {taskId, path} to its task workspace + rel path,
 *  mirroring workspaceDoc.ts discipline (no traversal, no absolute, one
 *  workspace per task). Returns null when the request is malformed. */
function resolveTarget(
  ctx: CollabRouteContext,
  taskId: unknown,
  docPath: unknown,
): { workspace: string; rel: string } | null {
  if (typeof taskId !== "string" || !taskId) return null;
  if (typeof docPath !== "string" || docPath.length === 0 || docPath.length > 512) return null;
  if (docPath.includes("..") || path.isAbsolute(docPath)) return null;
  let base: string;
  try {
    base = typeof ctx.workspace === "string" && ctx.workspace ? ctx.workspace : getSettings().workspace ?? "";
  } catch { return null; }
  if (!base) return null;
  let workspace: string;
  try {
    workspace = requireTaskWorkspace(taskId, base);
  } catch { return null; }
  const abs = path.resolve(workspace, docPath);
  const rel = path.relative(workspace, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return { workspace, rel };
}

/** Room identity string: unique per task + document. */
function roomRel(taskId: string, rel: string): string {
  return `${taskId}/${rel}`;
}

let reaper: NodeJS.Timeout | null = null;
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => collabRooms.reapIdle(), 20_000);
  reaper.unref();
}

export interface CollabRouteContext { workspace: string }

export async function handleCollabRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: CollabRouteContext,
): Promise<boolean> {
  if (!p.startsWith("/api/collab/")) return false;
  ensureReaper();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // POST /api/collab/join {taskId, path, clientId, name}
  if (p === "/api/collab/join" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== "object") { fail(res, 400, "invalid_json"); return true; }
    const { taskId, path: docPath, clientId, name } = body as Record<string, unknown>;
    const target = resolveTarget(ctx, taskId, docPath);
    if (!target || typeof clientId !== "string" || !clientId || clientId.length > 64) { fail(res, 400, "invalid_path"); return true; }
    const identity = roomRel(taskId as string, target.rel);
    let doc: TrackedDocument;
    try {
      const existing = loadDocTrack(target.workspace, target.rel);
      doc = (existing ?? { paragraphs: [], authors: {} }) as TrackedDocument;
      if (!doc || typeof doc !== "object" || !Array.isArray((doc as unknown as Record<string, unknown>).paragraphs)) throw new Error("bad doc");
    } catch {
      fail(res, 400, "invalid_doc");
      return true;
    }
    const result = collabRooms.join(identity, doc, clientId, typeof name === "string" ? name.slice(0, 64) : "محرّر");
    sendJson(res, 200, { ok: true, rel: target.rel, ...result });
    return true;
  }

  // GET /api/collab/stream?taskId&path&clientId&afterSeq — SSE: hello + catch-up
  // patches + live presence/patch events. Payloads are JSON.stringify'd and
  // sent as text/event-stream (never rendered as HTML by any consumer).
  if (p === "/api/collab/stream" && req.method === "GET") {
    const taskId = url.searchParams.get("taskId") ?? "";
    const docPath = url.searchParams.get("path") ?? "";
    const clientId = url.searchParams.get("clientId") ?? "";
    const target = resolveTarget(ctx, taskId, docPath);
    if (!target || !clientId) { fail(res, 400, "invalid_path"); return true; }
    const identity = roomRel(taskId, target.rel);
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const emit = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    emit("hello", { seq: 0, members: collabRooms.members(identity) });
    for (const patch of collabRooms.catchUp(identity, Number.isFinite(afterSeq) ? afterSeq : 0)) emit("patch", patch);
    const unsubscribe = collabRooms.subscribe(identity, emit);
    collabRooms.heartbeat(identity, clientId);
    const beat = setInterval(() => {
      collabRooms.heartbeat(identity, clientId);
      res.write(": ping\n\n");
    }, 15_000);
    req.on("close", () => {
      clearInterval(beat);
      unsubscribe();
    });
    return true;
  }

  // POST /api/collab/op {taskId, path, clientId, op, baseSeq}
  if (p === "/api/collab/op" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== "object") { fail(res, 400, "invalid_json"); return true; }
    const { taskId, path: docPath, clientId, op, baseSeq } = body as Record<string, unknown>;
    const target = resolveTarget(ctx, taskId, docPath);
    if (!target || typeof clientId !== "string" || !clientId) { fail(res, 400, "invalid_path"); return true; }
    if (!isCollabOp(op)) { fail(res, 400, "invalid_op"); return true; }
    const identity = roomRel(taskId as string, target.rel);
    const result = collabRooms.apply(identity, clientId, op, Number(baseSeq) || 0);
    if (!result.ok) {
      sendJson(res, result.reason === "stale" ? 409 : 400, {
        error: result.reason, seq: result.seq, paragraph: result.paragraph,
      });
      return true;
    }
    // Persist the canonical doc through the sidecar (same store the editor saves).
    const doc = collabRooms.document(identity);
    if (doc) {
      try {
        assertTrackPayload(doc);
        saveDocTrack(target.workspace, target.rel, doc);
      } catch { /* sidecar persistence is best-effort; the room stays canonical */ }
    }
    sendJson(res, 200, { ok: true, seq: result.seq, paragraph: result.paragraph });
    return true;
  }

  // POST /api/collab/leave {taskId, path, clientId}
  if (p === "/api/collab/leave" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== "object") { fail(res, 400, "invalid_json"); return true; }
    const { taskId, path: docPath, clientId } = body as Record<string, unknown>;
    const target = resolveTarget(ctx, taskId, docPath);
    if (!target || typeof clientId !== "string") { fail(res, 400, "invalid_path"); return true; }
    collabRooms.leave(roomRel(taskId as string, target.rel), clientId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

function isCollabOp(value: unknown): value is CollabOp {
  if (!value || typeof value !== "object") return false;
  const op = value as Record<string, unknown>;
  if (typeof op.paragraphId !== "string" || !op.paragraphId) return false;
  if (op.kind === "insert") return typeof op.offset === "number" && op.offset >= 0 && typeof op.text === "string" && op.text.length > 0 && op.text.length <= 4096;
  if (op.kind === "delete") return typeof op.offset === "number" && op.offset >= 0 && (op.direction === "backward" || op.direction === "forward");
  return false;
}
