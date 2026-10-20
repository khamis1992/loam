import http from "node:http";
import { getAgent } from "../agents.js";
import { listChildren } from "../agentSpawn.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Agent child routes. Dispatched before generic /api/agents/:id handlers. */
export async function handleAgentSpawnRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/agents/")) return false;
  const match = /^\/api\/agents\/([^\/]+)\/children$/.exec(p);
  if (!match) return false;
  const agentId = decodeURIComponent(match[1]!);

  if (!getAgent(agentId)) {
    sendJson(res, 404, { error: "agent not found" });
    return true;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  sendJson(res, 200, { children: listChildren(agentId) });
  return true;
}
