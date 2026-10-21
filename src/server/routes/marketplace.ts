import http from "node:http";
import {
  installFromCatalog,
  listActiveInstalls,
  loadMarketplaceCatalog,
} from "../marketplace.js";

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
 * Bots marketplace routes.
 * POST /api/agents/from-catalog  { catalogId } -> { agent, already, install }
 * GET  /api/marketplace/installs                -> { installs, count }
 * GET  /api/marketplace/catalog                 -> { catalog, count, version }
 */
export async function handleMarketplaceRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p === "/api/agents/from-catalog") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    const catalogId = typeof (body as { catalogId?: unknown }).catalogId === "string"
      ? (body as { catalogId: string }).catalogId.trim()
      : "";
    if (!catalogId) {
      sendJson(res, 400, { error: "catalogId is required" });
      return true;
    }
    const result = installFromCatalog(catalogId);
    if ("error" in result) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, { agent: result.agent, already: result.already, install: result.install });
    return true;
  }

  if (p === "/api/marketplace/installs" && req.method === "GET") {
    const installs = listActiveInstalls();
    sendJson(res, 200, { installs, count: installs.length });
    return true;
  }

  if (p === "/api/marketplace/catalog" && req.method === "GET") {
    const { entries, version } = loadMarketplaceCatalog();
    sendJson(res, 200, { catalog: entries, count: entries.length, version });
    return true;
  }

  return false;
}
