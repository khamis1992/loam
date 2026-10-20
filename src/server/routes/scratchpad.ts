import http from "node:http";
import { getAgent } from "../agents.js";
import {
  addScratchpadItem,
  completeScratchpadItem,
  listScratchpadItems,
  removeScratchpadItem,
  type ScratchpadStatus,
} from "../scratchpad.js";

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

/** Agent scratchpad routes. Dispatched before generic /api/agents/:id handlers. */
export async function handleScratchpadRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/agents/")) return false;
  const match = /^\/api\/agents\/([^\/]+)\/scratchpad(?:\/([^\/]+)(?:\/(complete))?)?$/.exec(p);
  if (!match) return false;
  const agentId = decodeURIComponent(match[1]!);
  const itemId = match[2] ? decodeURIComponent(match[2]) : undefined;
  const action = match[3];

  if (!getAgent(agentId)) {
    sendJson(res, 404, { error: "agent not found" });
    return true;
  }

  if (req.method === "GET" && !itemId) {
    const status = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).searchParams.get("status") as
      | ScratchpadStatus
      | undefined;
    const items = listScratchpadItems(agentId, status && ["open", "done"].includes(status) ? status : undefined);
    sendJson(res, 200, { items });
    return true;
  }

  if (req.method === "POST" && !itemId) {
    const body = (await readJson(req)) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return true;
    }
    const item = addScratchpadItem(agentId, text);
    sendJson(res, 200, { item });
    return true;
  }

  if (req.method === "POST" && itemId && action === "complete") {
    const item = completeScratchpadItem(agentId, itemId);
    if (!item) {
      sendJson(res, 404, { error: "scratchpad item not found or already completed" });
      return true;
    }
    sendJson(res, 200, { item });
    return true;
  }

  if (req.method === "DELETE" && itemId && !action) {
    const deleted = removeScratchpadItem(agentId, itemId);
    sendJson(res, 200, { deleted });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
