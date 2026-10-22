import http from "node:http";
import { getAgent } from "../agents.js";
import { getThread, listThreads, markSeen, setThread } from "../agentThreads.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 32_000): Promise<unknown> {
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

/** Agent thread-mapping routes: list, set, and seen. Dispatched before generic /api/agents/:id handlers. */
export async function handleAgentThreadRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p === "/api/agent-threads" && req.method === "GET") {
    sendJson(res, 200, { threads: listThreads() });
    return true;
  }

  if (!p.startsWith("/api/agents/")) return false;
  const match = /^\/api\/agents\/([^\/]+)\/thread(?:\/(seen))?$/.exec(p);
  if (!match) return false;
  const agentId = decodeURIComponent(match[1]!);
  const action = match[2];

  if (!getAgent(agentId)) {
    sendJson(res, 404, { error: "agent not found" });
    return true;
  }

  if (req.method === "GET" && !action) {
    const item = getThread(agentId);
    if (!item) {
      sendJson(res, 404, { error: "agent thread not found" });
    } else {
      sendJson(res, 200, { item });
    }
    return true;
  }

  if ((req.method === "PUT" || req.method === "POST") && !action) {
    const body = (await readJson(req)) as { threadUid?: unknown };
    if (typeof body.threadUid !== "string" || !body.threadUid.trim()) {
      sendJson(res, 400, { error: "threadUid is required" });
      return true;
    }
    const item = setThread(agentId, body.threadUid);
    sendJson(res, 200, { item });
    return true;
  }

  if (req.method === "POST" && action === "seen") {
    try {
      const item = markSeen(agentId);
      sendJson(res, 200, { item });
    } catch {
      sendJson(res, 404, { error: "agent thread not found" });
    }
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
