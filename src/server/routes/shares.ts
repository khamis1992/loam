import http from "node:http";
import { getTask } from "../db.js";
import { createShare, getActiveShare, revokeShare, sanitizeTranscript } from "../shares.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Build the share replay URL from the incoming request (Host header). */
function shareUrl(req: http.IncomingMessage, token: string): string {
  const host = typeof req.headers.host === "string" && req.headers.host ? req.headers.host : "127.0.0.1";
  const proto = req.headers["x-forwarded-proto"] === "https" || (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  return `${proto}://${host}/share?t=${encodeURIComponent(token)}`;
}

/**
 * Public share routes (option #11):
 *   POST   /api/tasks/:id/share  -> { token, url, taskId, createdAt }
 *   DELETE /api/shares/:token    -> { ok: true }
 *   GET    /api/share/:token     -> { share: {taskId, createdAt}, transcript }
 *
 * POST/DELETE are mounted behind the local install token like every other
 * /api route; GET /api/share/:token is the read-only public replay feed and
 * should be added to the http.ts public paths so anonymous visitors can read
 * it. Unknown and revoked tokens both answer 404 (never a "revoked" hint).
 */
export async function handleShareRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  // Create (or reuse the active share of) one task.
  if (req.method === "POST" && p.startsWith("/api/tasks/") && p.endsWith("/share")) {
    const id = decodeURIComponent(p.slice("/api/tasks/".length, -"/share".length));
    const task = getTask(id);
    if (!task) return (sendJson(res, 404, { error: "task not found" }), true);
    const share = createShare(id);
    if (!share) return (sendJson(res, 404, { error: "task not found" }), true);
    sendJson(res, 200, { token: share.token, url: shareUrl(req, share.token), taskId: share.taskId, createdAt: share.createdAt });
    return true;
  }

  // Revoke one share token.
  const revokeMatch = /^\/api\/shares\/([A-Za-z0-9_-]+)$/.exec(p);
  if (revokeMatch && req.method === "DELETE") {
    const ok = revokeShare(revokeMatch[1]!);
    if (!ok) return (sendJson(res, 404, { error: "share not found" }), true);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // Public read-only transcript replay.
  const readMatch = /^\/api\/share\/([A-Za-z0-9_-]+)$/.exec(p);
  if (readMatch && req.method === "GET") {
    const share = getActiveShare(readMatch[1]!);
    const task = share ? getTask(share.taskId) : undefined;
    if (!share || !task) return (sendJson(res, 404, { error: "share not found" }), true);
    sendJson(res, 200, {
      share: { taskId: share.taskId, createdAt: share.createdAt },
      transcript: sanitizeTranscript(task),
    });
    return true;
  }

  return false;
}
