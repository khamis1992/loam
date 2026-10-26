import http from "node:http";
import { spansForTask, spansForTrace, exportOtlp } from "../../orchestration/tracing/tracer.js";

/**
 * C5 routes (BUILD_SPEC §4.0.5): read-only span queries + explicit opt-in
 * OTLP export (409 when no endpoint is configured).
 *   GET /api/traces/task/:taskId?limit=
 *   GET /api/traces/:traceId
 *   POST /api/traces/export  { taskId }
 */
export async function handleTracesRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  deps: { sendJson: (res: http.ServerResponse, status: number, body: unknown) => void; otlpEndpoint: () => string; readBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<unknown> },
): Promise<boolean> {
  if (!p.startsWith("/api/traces/")) return false;
  const reply = (status: number, body: unknown): true => { deps.sendJson(res, status, body); return true; };

  const task = /^\/api\/traces\/task\/([^/]+)$/.exec(p);
  if (task && req.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 5000, 1), 50_000);
    return reply(200, { spans: spansForTask(decodeURIComponent(task[1] ?? ""), limit) });
  }
  const trace = /^\/api\/traces\/([0-9a-f]{32})$/.exec(p);
  if (trace && req.method === "GET") {
    return reply(200, { spans: spansForTrace(trace[1] ?? "") });
  }
  if (p === "/api/traces/export" && req.method === "POST") {
    const endpoint = deps.otlpEndpoint();
    if (!endpoint) return reply(409, { error: "no otlp endpoint configured (Settings > Tracing)" });
    let body: { taskId?: unknown };
    try {
      body = (await deps.readBody(req, 8_000)) as { taskId?: unknown };
    } catch {
      return reply(400, { error: "invalid body" });
    }
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!taskId) return reply(400, { error: "taskId required" });
    try {
      const ok = await exportOtlp(endpoint, spansForTask(taskId));
      return ok ? reply(200, { ok }) : reply(502, { ok: false });
    } catch (e) {
      return reply(502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return reply(404, { error: "unknown traces route" });
}
