// GET /api/craft/status — which vendored Loam Craft app dists are installed.
// The web panel uses this to decide whether to open the real Craft app for a
// file type or fall back to Loam's own editor.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readCraftStatus } from "../craftStatus.js";
import { ROOT } from "../../config.js";

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
  // Resolve the project root in the same order the rest of the server does:
  // an explicit override, then LOAM_ROOT (set by config.ts / the Electron main
  // process), then MANUS_LOCAL_ROOT, then the import-time ROOT. Falling back to
  // ROOT keeps production correct even if the env vars are absent or point at a
  // different tree than the server itself was started from.
  const root = opts.root ?? process.env.LOAM_ROOT ?? process.env.MANUS_LOCAL_ROOT ?? ROOT;
  if (req.method === "GET" && p === "/api/craft/status") {
    sendJson(res, 200, { apps: readCraftStatus(root) });
    return true;
  }
  sendJson(res, 404, { error: "Not found" });
  return true;
}
