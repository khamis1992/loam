import http from "node:http";
import { getAgent } from "../agents.js";
import { log } from "../../log.js";
import {
  appendMirrorToThread,
  executeGrokbotTask,
  listMirrors,
  resolveGrokbotAgentRef,
  storeMirror,
  type GrokBotMirrorMessage,
} from "../bridge/grokbot.js";

/**
 * Phase 3: one-way Grok Bot -> Loam bridge routes.
 *
 *   POST /api/bridge/grokbot/mirror {agentRef, from, text, ts?, execute?}
 *        -> stores a READ-ONLY inbound note for the agent (never runs anything)
 *   GET  /api/bridge/grokbot/mirror?agentRef=... -> { messages: [...] }
 *   POST /api/bridge/grokbot/task {agentRef, text, execute:true, token}
 *        -> enqueues a real run (token required, rate-limited)
 */

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<unknown> {
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

async function handleMirrorIngest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  let body: { agentRef?: unknown; from?: unknown; text?: unknown; ts?: unknown; execute?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
  const agentRef = typeof body.agentRef === "string" ? body.agentRef.trim() : "";
  if (!agentRef) return (sendJson(res, 400, { error: "agentRef is required" }), true);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";
  if (!text) return (sendJson(res, 400, { error: "text is required" }), true);
  const agentId = resolveGrokbotAgentRef(agentRef);
  if (!agentId) return (sendJson(res, 404, { error: "no grokbot agent matches agentRef" }), true);
  const from = typeof body.from === "string" && body.from.trim() ? body.from.trim().slice(0, 80) : "Grok Bot";
  const ts = typeof body.ts === "string" ? body.ts : undefined;
  if (body.execute === true) {
    // Mirror ingest is strictly read-only; execution must use /task with a token.
    return (sendJson(res, 400, { error: "mirror ingest never executes; use /api/bridge/grokbot/task with a token" }), true);
  }
  const threadAppended = appendMirrorToThread(agentId, text);
  const message = storeMirror({ agentId, from, text, ...(ts ? { ts } : {}), threadAppended });
  log.info(`grokbot bridge: mirrored note for agent ${getAgent(agentId)?.name ?? agentId} (${text.length} chars)`);
  sendJson(res, 200, { agentId, message });
  return true;
}

function toPublicMessage(m: GrokBotMirrorMessage): Record<string, unknown> {
  return { id: m.id, from: m.from, text: m.text, ts: m.ts, receivedAt: m.receivedAt, execute: m.execute, threadAppended: m.threadAppended };
}

export async function handleGrokbotBridgeRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url?: URL,
): Promise<boolean> {
  if (req.method === "POST" && p === "/api/bridge/grokbot/mirror") {
    return handleMirrorIngest(req, res);
  }
  if (req.method === "GET" && p === "/api/bridge/grokbot/mirror") {
    const agentRef = url?.searchParams.get("agentRef") ?? url?.searchParams.get("agentId") ?? "";
    const agentId = resolveGrokbotAgentRef(agentRef) ?? (getAgent(agentRef) ? agentRef : undefined);
    if (!agentId) return (sendJson(res, 404, { error: "no grokbot agent matches agentRef" }), true);
    const limit = Number(url?.searchParams.get("limit") ?? 50);
    const messages = listMirrors(agentId, Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : 50);
    sendJson(res, 200, { agentId, messages: messages.map(toPublicMessage) });
    return true;
  }
  if (req.method === "POST" && p === "/api/bridge/grokbot/task") {
    let body: { agentRef?: unknown; text?: unknown; execute?: unknown; token?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    const result = executeGrokbotTask(body);
    sendJson(res, result.status, result.body);
    return true;
  }
  return false;
}
