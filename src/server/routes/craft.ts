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
): Promise<boolean> {
  if (!p.startsWith("/api/craft")) return false;
  if (req.method === "GET" && p === "/api/craft/status") {
    sendJson(res, 200, { apps: readCraftStatus() });
    return true;
  }
  sendJson(res, 404, { error: "Not found" });
  return true;
}
