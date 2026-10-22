// GET /api/craft/status — which vendored Loam Craft app dists are installed.
// The web panel uses this to decide whether to open the real Craft app for a
// file type or fall back to Loam's own editor.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readCraftStatus } from "../craftStatus.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export async function handleCraftRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  opts: { root?: string } = {},
): Promise<boolean> {
  if (!p.startsWith("/api/craft")) return false;
  // The route reads the project root from LOAM_ROOT (set by config.ts / the
  // Electron main process) instead of the import-time default, so tests and a
  // packaged install can point it at a different tree.
  const root = opts.root ?? process.env.LOAM_ROOT ?? process.env.MANUS_LOCAL_ROOT;
  if (req.method === "GET" && p === "/api/craft/status") {
    sendJson(res, 200, { apps: readCraftStatus(root) });
    return true;
  }
  sendJson(res, 404, { error: "Not found" });
  return true;
}
