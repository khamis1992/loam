/**
 * HTTP route for idle session hibernation (J7).
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md — the same debug surface
 * discipline: `client:hibernation` returns state, before/after readings and
 * counts, and `client:hibernate` requests immediate hibernation for testing.
 * Loam's version is mounted on the existing loopback server behind the same
 * install token as every other `/api/*` route.
 *
 *   GET  /api/sessions/:id/hibernation   -> record + counters
 *   POST /api/sessions/:id/hibernate     -> request immediate hibernation
 *   POST /api/sessions/:id/wake          -> wake (the same wake the first
 *                                            keystroke performs)
 *   GET  /api/hibernation                -> process-wide counters
 *
 * Boundaries that keep this local-only and safe:
 * - GET is read-only; the POSTs only ever drop *derived* caches through
 *   `HibernationManager.hibernateSession`, whose guards refuse to touch a
 *   session with an in-flight tool/agent turn, pending input or a scheduled
 *   wake;
 * - responses are marked `cache-control: no-store` and contain no prompt text,
 *   no file paths and no tokens.
 */
import http from "node:http";
import { sessionHibernation } from "../../memory/hibernation.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** Mount via http.ts:
 *   if (await handleHibernationRoutes(req, res, p)) return;
 *   if (await handleHibernationProcessRoutes(req, res, p)) return;
 */
export async function handleHibernationRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  const match = /^\/api\/sessions\/([^/]+)\/(hibernation|hibernate|wake)$/.exec(p);
  if (!match) return false;
  const sessionId = decodeURIComponent(match[1]!);
  const action = match[2]!;

  if (req.method === "GET" && action === "hibernation") {
    sendJson(res, 200, {
      record: sessionHibernation.getRecord(sessionId) ?? null,
      state: sessionHibernation.getState(sessionId),
      msUntilHibernation: sessionHibernation.msUntilHibernation(sessionId),
      disabled: sessionHibernation.disabled,
    });
    return true;
  }

  if (req.method === "POST" && action === "hibernate") {
    const record = sessionHibernation.hibernateSession(sessionId);
    sendJson(res, 200, {
      record,
      state: record.state,
      releasedEntries: record.lastReleasedEntries,
      releasedBytes: record.lastReleasedBytes,
      ...(record.lastError ? { error: record.lastError } : {}),
    });
    return true;
  }

  if (req.method === "POST" && action === "wake") {
    const record = sessionHibernation.wake(sessionId, "user-input");
    sendJson(res, 200, { record, state: record.state });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}

/** GET /api/hibernation — process-wide counters for the J6 debug surface. */
export async function handleHibernationProcessRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (p !== "/api/hibernation") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const stats = sessionHibernation.stats();
  sendJson(res, 200, { ...stats, sessions: sessionHibernation.listRecords() });
  return true;
}
