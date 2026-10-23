/**
 * Ask-User-More HTTP surface (Neo N9). Mounted next to the other /api/ handlers.
 * Routes:
 *   GET    /api/ask-user                 → { requests }   (?pending=0 → all)
 *   GET    /api/ask-user/:id             → { request }
 *   POST   /api/ask-user/:id/answer      → { request }    (text + per-question answers + files)
 *   POST   /api/ask-user/:id/dismiss     → { request }
 *
 * The web ask-user card posts the answer here; the waiting `ask_user` tool is
 * resumed through the shared pending store (`askUserStore.ts`). Files are
 * uploaded first through `/api/upload?taskId=<id>&askUser=<requestId>`, which
 * places them under `<workspace>/uploads/<requestId>/`; the answer records those
 * workspace-relative paths.
 */
import http from "node:http";
import { answerAskUser, dismissAskUser, getAskUser, listAskUsers, serializeAskUser, type AskUserAnswer, type AskUserFile } from "../../tools/askUserStore.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Normalise the answer body; returns an error string when it is unusable. */
function parseAnswer(body: Record<string, unknown>): AskUserAnswer | { error: string } {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const rawAnswers = body.answers;
  const answers: Record<string, string> = {};
  if (rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)) {
    for (const [key, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) answers[key] = value.trim().slice(0, 4000);
    }
  }
  const rawFiles = body.files;
  const files: AskUserFile[] = [];
  if (Array.isArray(rawFiles)) {
    for (const item of rawFiles.slice(0, 8)) {
      if (typeof item !== "object" || item === null) continue;
      const f = item as Record<string, unknown>;
      const rel = typeof f.path === "string" ? f.path.trim() : "";
      if (!rel || rel.includes("..")) continue;
      files.push({
        path: rel,
        name: typeof f.name === "string" && f.name.trim() ? f.name.trim() : rel.split("/").pop() ?? "attachment",
        bytes: typeof f.bytes === "number" ? f.bytes : 0,
        contentType: typeof f.contentType === "string" ? f.contentType : "application/octet-stream",
      });
    }
  }
  if (!text && Object.keys(answers).length === 0 && files.length === 0) {
    return { error: "answer requires text, at least one answer, or a file" };
  }
  return { text: text.slice(0, 4000), answers, files };
}

/** Ask-user routes. Dispatch before generic handlers; scoped to /api/ask-user. */
export async function handleAskUserRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/ask-user")) return false;

  if (req.method === "GET" && p === "/api/ask-user") {
    const pendingOnly = new URL(req.url ?? p, "http://localhost").searchParams.get("pending") !== "0";
    sendJson(res, 200, { requests: listAskUsers(pendingOnly).map(serializeAskUser) });
    return true;
  }

  const idMatch = p.match(/^\/api\/ask-user\/([^/]+)$/);
  const actionMatch = p.match(/^\/api\/ask-user\/([^/]+)\/(answer|dismiss)$/);
  // Not a path this module owns (sibling prefix, trailing slash): fall through.
  if (!idMatch && !actionMatch) return false;

  if (actionMatch) {
    const id = decodeURIComponent(actionMatch[1]!);
    const action = actionMatch[2]!;
    const existing = getAskUser(id);
    if (!existing) {
      sendJson(res, 404, { error: "طلب التوضيح غير موجود" });
      return true;
    }
    if (existing.status !== "pending") {
      sendJson(res, 409, { error: "بُتّ في هذا الطلب مسبقًا", request: serializeAskUser(existing) });
      return true;
    }
    if (req.method !== "POST") return false;
    if (action === "dismiss") {
      const record = dismissAskUser(id)!;
      sendJson(res, 200, { request: serializeAskUser(record) });
      return true;
    }
    const body = await readJson(req);
    const parsed = parseAnswer(body);
    if ("error" in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    const record = answerAskUser(id, parsed)!;
    sendJson(res, 200, { request: serializeAskUser(record) });
    return true;
  }

  if (!idMatch) return false;
  const id = decodeURIComponent(idMatch[1]!);

  if (req.method === "GET") {
    const request = getAskUser(id);
    if (!request) {
      sendJson(res, 404, { error: "طلب التوضيح غير موجود" });
      return true;
    }
    sendJson(res, 200, { request: serializeAskUser(request) });
    return true;
  }

  // GET is the only supported verb on the bare id path; anything else falls
  // through so the request gets the server's normal 404 instead of hanging.
  return false;
}
