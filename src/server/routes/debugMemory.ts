/**
 * HTTP route for the local `debug:memory` surface (J6).
 *
 * Adapted from jcode (MIT) src/tui/app/debug_cmds.rs — the debug surface is the
 * contract that makes memory regressions reviewable. Loam's version returns
 * per-process RSS (this server process, the desktop main process and any
 * renderer windows the desktop main reports) plus one counter row per bounded
 * cache registered through `src/memory/stats.js`.
 *
 * Boundaries that keep this local-only:
 * - mounted on the existing loopback server, which requires the same install
 *   token as every other `/api/*` route;
 * - GET only, no request body, response marked `cache-control: no-store`;
 * - returns no secrets, no prompt text, no file paths outside the process
 *   counters.
 */
import http from "node:http";
import { collectMemoryProfile, type MemoryProfile } from "../../memory/profile.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** GET /api/debug/memory — local RSS + bounded-cache counters. */
export async function handleDebugMemoryRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (p !== "/api/debug/memory") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const profile: MemoryProfile = collectMemoryProfile();
  sendJson(res, 200, profile);
  return true;
}
