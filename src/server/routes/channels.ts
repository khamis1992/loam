import http from "node:http";
import { getAgent } from "../agents.js";
import { channelStatus, createBinding, deleteBinding, getBinding, isChannelName, listBindings } from "../channels/router.js";

/** MF11: messaging channel routes. Dispatched near the /api/agents handlers. */

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

/**
 * Channel routes:
 *   GET    /api/channels                     -> { channels: [{ name, configured, envVarNames, hint? }] }
 *   GET    /api/agents/:id/channels           -> { bindings: [...] }
 *   POST   /api/agents/:id/channels           { channel, chatId | address } -> { binding }
 *   DELETE /api/agents/:id/channels/:bindingId -> { deleted }
 */
export async function handleChannelRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p === "/api/channels" && req.method === "GET") {
    sendJson(res, 200, { channels: channelStatus() });
    return true;
  }

  const bindMatch = /^\/api\/agents\/([^\/]+)\/channels\/([^\/]+)$/.exec(p);
  if (bindMatch && req.method === "DELETE") {
    const agentId = decodeURIComponent(bindMatch[1]!);
    const bindingId = decodeURIComponent(bindMatch[2]!);
    if (!getAgent(agentId)) {
      sendJson(res, 404, { error: "agent not found" });
      return true;
    }
    const binding = getBinding(bindingId);
    if (!binding || binding.agentId !== agentId) {
      sendJson(res, 404, { error: "binding not found" });
      return true;
    }
    sendJson(res, 200, { deleted: deleteBinding(bindingId) });
    return true;
  }

  const agentMatch = /^\/api\/agents\/([^\/]+)\/channels$/.exec(p);
  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]!);
    if (!getAgent(agentId)) {
      sendJson(res, 404, { error: "agent not found" });
      return true;
    }

    if (req.method === "GET") {
      sendJson(res, 200, { bindings: listBindings(agentId) });
      return true;
    }

    if (req.method === "POST") {
      const body = (await readJson(req)) as { channel?: unknown; chatId?: unknown; address?: unknown };
      const chatId = typeof body.chatId === "string" && body.chatId.trim()
        ? body.chatId.trim()
        : typeof body.address === "string" && body.address.trim()
          ? body.address.trim()
          : "";
      if (!isChannelName(body.channel) || !chatId) {
        sendJson(res, 400, { error: "channel ('telegram'|'email') and a non-empty chatId (or address) are required" });
        return true;
      }
      try {
        const binding = createBinding(body.channel, chatId, agentId);
        sendJson(res, 200, { binding });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  return false;
}
