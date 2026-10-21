import http from "node:http";
import { createApiKey, listApiKeys, revokeApiKey } from "../apiKeys.js";

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

/** Developer API keys: list, create (key returned exactly once) and revoke. */
export async function handleApiKeysRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (!p.startsWith("/api/api-keys")) return false;

  if (p === "/api/api-keys" && req.method === "GET") {
    sendJson(res, 200, { keys: listApiKeys() });
    return true;
  }

  if (p === "/api/api-keys" && req.method === "POST") {
    const body = (await readJson(req)) as { name?: unknown };
    const created = createApiKey(body.name);
    // The raw key appears only here; afterwards only its SHA-256 hash is stored.
    sendJson(res, 201, { ...created, keys: listApiKeys() });
    return true;
  }

  const revoke = /^\/api\/api-keys\/([^\/]+)\/revoke$/.exec(p);
  if (revoke && req.method === "POST") {
    const id = decodeURIComponent(revoke[1]!);
    const revoked = revokeApiKey(id);
    if (!revoked) return sendJson(res, 404, { error: "api key not found or already revoked" }), true;
    sendJson(res, 200, { revoked: true, keys: listApiKeys() });
    return true;
  }

  if (p.startsWith("/api/api-keys")) {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  return false;
}
