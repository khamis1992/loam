/**
 * C11 HTTP surface: /api/realswarm/runs. Same guards as /api/swarm/runs
 * (src/server/http.ts:604-640): cache-control no-store, 503 when the service is
 * absent, non-GET requests must be same-origin and application/json, body limit 80 KB.
 * Mounted in http.ts directly after the /api/swarm/runs block.
 */
import http from "node:http";
import { RealSwarmError, type RealSwarmService } from "../../orchestration/swarm/service.js";
import type { CreateRealSwarmInput } from "../../orchestration/swarm/types.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, max = 80_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body_too_large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function handleRealSwarmRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, service: RealSwarmService | null): Promise<boolean> {
  if (p !== "/api/realswarm/runs" && !p.startsWith("/api/realswarm/runs/")) return false;
  const reply = (status: number, body: unknown): true => {
    sendJson(res, status, body);
    return true;
  };
  res.setHeader("cache-control", "no-store");
  if (!service) return reply(503, { error: "فريق البرمجة غير متاح في هذه الجلسة" });
  if (req.method !== "GET") {
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") {
      return reply(403, { error: "طلبات التشغيل مسموحة من التطبيق فقط" });
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      return reply(415, { error: "application/json required" });
    }
  }
  try {
    if (p === "/api/realswarm/runs") {
      if (req.method === "GET") return reply(200, { runs: service.list() });
      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          return reply(400, { error: "Invalid JSON request" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Expected an object" });
        return reply(201, { run: service.create(body as CreateRealSwarmInput) });
      }
      return reply(405, { error: "Method not allowed" });
    }
    const m = /^\/api\/realswarm\/runs\/(realswarm_[a-f0-9-]{36})(?:\/(cancel|retry|resume|board))?$/.exec(p);
    if (!m) return reply(404, { error: "Run endpoint not found" });
    const id = m[1]!;
    if (req.method === "GET" && !m[2]) return reply(200, { run: service.get(id) });
    if (req.method === "GET" && m[2] === "board") return reply(200, service.board(id));
    if (req.method === "POST" && m[2] === "cancel") return reply(200, { run: service.cancel(id) });
    if (req.method === "POST" && m[2] === "retry") return reply(202, { run: service.retry(id) });
    if (req.method === "POST" && m[2] === "resume") return reply(202, { run: service.resume(id) });
    return reply(405, { error: "Method not allowed" });
  } catch (err) {
    if (err instanceof RealSwarmError) return reply(err.status, { error: err.message });
    throw err;
  }
}
