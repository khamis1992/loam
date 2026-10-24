import http from "node:http";
import type { Config } from "../../config.js";
import { getManifest, listBridges, setBridgeEnabled } from "../../bridges/registry.js";
import { writeBridgeSkill } from "../../bridges/skillGen.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 4_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * App bridge routes:
 *  - GET  /api/bridges                 → { bridges: BridgeInfo[] }
 *  - PUT  /api/bridges/:id  {enabled}  → flips the bridge for this run
 *  - POST /api/bridges/:id/skill       → writes skills/bridge-<id>/SKILL.md
 */
export async function handleBridgesRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, cfg: Config): Promise<boolean> {
  if (p !== "/api/bridges" && !p.startsWith("/api/bridges/")) return false;
  try {
    if (p === "/api/bridges" && req.method === "GET") {
      sendJson(res, 200, { bridges: await listBridges(cfg) });
      return true;
    }
    const m = /^\/api\/bridges\/([a-z][a-z0-9_-]{0,39})(\/skill)?$/.exec(p);
    const manifest = m ? getManifest(m[1]!) : undefined;
    if (!m || !manifest) {
      sendJson(res, 404, { error: "unknown bridge" });
      return true;
    }
    if (m[2] === "/skill" && req.method === "POST") {
      sendJson(res, 200, { file: writeBridgeSkill(manifest) });
      return true;
    }
    if (!m[2] && req.method === "PUT") {
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") {
        sendJson(res, 400, { error: "enabled must be a boolean" });
        return true;
      }
      setBridgeEnabled(cfg, manifest.id, body.enabled);
      const info = (await listBridges(cfg)).find((b) => b.id === manifest.id);
      sendJson(res, 200, { bridge: info });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
