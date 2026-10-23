import http from "node:http";
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_STEP_LIMIT,
  DEFAULT_TOKEN_LIMIT,
  sessionRuntime,
} from "../sessionRuntime.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 8_000): Promise<unknown> {
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
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Session sleep/wake + compute budget routes (D19).
 *
 *   GET  /api/sessions/:id/runtime   -> badge state (sleep + budget)
 *   POST /api/sessions/:id/sleep     -> force sleep (resource release)
 *   POST /api/sessions/:id/wake      -> force wake (restore)
 *   POST /api/sessions/:id/budget    -> raise the compute budget
 *
 * Mount via http.ts:
 *   if (await handleSessionRuntimeRoutes(req, res, p)) return;
 */
export async function handleSessionRuntimeRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  const match = /^\/api\/sessions\/([^/]+)\/(runtime|sleep|wake|budget)$/.exec(p);
  if (!match) return false;
  const sessionId = decodeURIComponent(match[1]!);
  const action = match[2]!;

  if (req.method === "GET" && action === "runtime") {
    sendJson(res, 200, {
      session: sessionRuntime.snapshot(sessionId),
      defaults: { idleMinutes: DEFAULT_IDLE_MINUTES, stepLimit: DEFAULT_STEP_LIMIT, tokenLimit: DEFAULT_TOKEN_LIMIT },
    });
    return true;
  }

  if (req.method === "POST" && action === "sleep") {
    await sessionRuntime.forceSleep(sessionId, "manual");
    sendJson(res, 200, { session: sessionRuntime.snapshot(sessionId) });
    return true;
  }

  if (req.method === "POST" && action === "wake") {
    await sessionRuntime.forceWake(sessionId, "manual");
    sendJson(res, 200, { session: sessionRuntime.snapshot(sessionId) });
    return true;
  }

  if (req.method === "POST" && action === "budget") {
    let body: { steps?: unknown; tokens?: unknown };
    try {
      body = (await readJson(req)) as { steps?: unknown; tokens?: unknown };
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const steps = typeof body.steps === "number" && Number.isFinite(body.steps) ? Math.floor(body.steps) : undefined;
    const tokens = typeof body.tokens === "number" && Number.isFinite(body.tokens) ? Math.floor(body.tokens) : undefined;
    if (steps === undefined && tokens === undefined) {
      sendJson(res, 400, { error: "steps or tokens increase is required" });
      return true;
    }
    const result = sessionRuntime.raise(sessionId, { ...(steps !== undefined ? { steps } : {}), ...(tokens !== undefined ? { tokens } : {}) });
    if (!result.ok) {
      sendJson(res, 400, { error: result.reason ?? "invalid increase", session: sessionRuntime.snapshot(sessionId) });
      return true;
    }
    // A raise clears the stop flag: the run may be resumed immediately.
    sessionRuntime.resumeAfterRaise(sessionId);
    sendJson(res, 200, { session: sessionRuntime.snapshot(sessionId), raised: true });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
