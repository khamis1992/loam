import http from "node:http";
import type { Config } from "../../config.js";
import { listHandoffs, resolveHandoff } from "../../wiki/handoff.js";
import { wikiRoot } from "../../wiki/paths.js";
import { deletePage, listPages, readPage } from "../../wiki/store.js";
import { PAGE_KINDS, type PageKind } from "../../wiki/types.js";
import { search } from "../../wiki/wikiIndex.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 16_000): Promise<Record<string, unknown>> {
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

const kindOf = (v: string | null): PageKind | undefined => ((PAGE_KINDS as readonly string[]).includes(v ?? "") ? (v as PageKind) : undefined);

/**
 * Project wiki routes, scoped to the active workspace:
 *  - GET/PUT /api/project-wiki/status        → { enabled } (PUT {enabled} flips it for this run)
 *  - GET     /api/project-wiki/pages?kind=   → page metadata
 *  - GET     /api/project-wiki/search?q=     → BM25 hits
 *  - GET/DELETE /api/project-wiki/page?kind=&id=
 *  - GET     /api/handoffs?state=    → handoffs
 *  - POST    /api/handoffs/:id       → {to: accepted|dismissed}
 */
export async function handleProjectWikiRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL | undefined, cfg: Config): Promise<boolean> {
  if (!p.startsWith("/api/project-wiki") && !p.startsWith("/api/handoffs")) return false;
  try {
    const q = url?.searchParams;
    if (p === "/api/project-wiki/status") {
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" }), true;
        cfg.wiki = { enabled: body.enabled };
      }
      sendJson(res, 200, { enabled: cfg.wiki?.enabled === true });
      return true;
    }
    if (!cfg.wiki?.enabled) {
      sendJson(res, 409, { error: "wiki disabled", enabled: false });
      return true;
    }
    const root = wikiRoot(cfg.workspace);
    if (p === "/api/project-wiki/pages" && req.method === "GET") {
      sendJson(res, 200, { pages: listPages(root, kindOf(q?.get("kind") ?? null)).map((pg) => pg) });
      return true;
    }
    if (p === "/api/project-wiki/search" && req.method === "GET") {
      const query = (q?.get("q") ?? "").trim();
      sendJson(res, 200, { hits: query ? search(root, query, { limit: 20 }) : [] });
      return true;
    }
    if (p === "/api/project-wiki/page") {
      const kind = kindOf(q?.get("kind") ?? null);
      const id = q?.get("id") ?? "";
      if (!kind || !id) return sendJson(res, 400, { error: "kind and id are required" }), true;
      if (req.method === "GET") {
        const page = readPage(root, kind, id);
        return page ? sendJson(res, 200, { page }) : sendJson(res, 404, { error: "page not found" }), true;
      }
      if (req.method === "DELETE") {
        return sendJson(res, 200, { deleted: deletePage(root, kind, id) }), true;
      }
      return false;
    }
    if (p === "/api/handoffs" && req.method === "GET") {
      const s = q?.get("state");
      sendJson(res, 200, { handoffs: listHandoffs(root, s === "open" || s === "accepted" || s === "dismissed" ? s : undefined) });
      return true;
    }
    if (p.startsWith("/api/handoffs/") && req.method === "POST") {
      const id = decodeURIComponent(p.slice("/api/handoffs/".length));
      const body = await readJson(req);
      if (body.to !== "accepted" && body.to !== "dismissed") return sendJson(res, 400, { error: "to must be accepted or dismissed" }), true;
      return resolveHandoff(root, id, body.to)
        ? sendJson(res, 200, { id, state: body.to })
        : sendJson(res, 409, { error: "handoff not found or already resolved" }), true;
    }
    return false;
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
