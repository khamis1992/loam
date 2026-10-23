/**
 * Repo wiki routes (D8). Mounted next to the other /api handlers:
 *   import { handleWikiRoutes } from "./routes/wiki.js";
 *   if (await handleWikiRoutes(req, res, p, { workspace: cfg.workspace, ollama, model: cfg.model })) return;
 *
 * - GET  /api/wiki                 list wikis (projects) with their pages
 * - GET  /api/wiki/:project        one wiki: project + pages
 * - GET  /api/wiki/:project/:slug  one page's markdown
 * - POST /api/wiki/:project/generate  build/refresh the wiki (requires the model)
 */
import http from "node:http";
import { getSettings } from "../settings.js";
import {
  generateWiki,
  listWikiProjects,
  readWikiIndex,
  wikiRoot,
  type WikiModelClient,
} from "../../tools/wiki.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function resolveWorkspace(ctx: { workspace?: string } | undefined): string {
  if (typeof ctx?.workspace === "string" && ctx.workspace) return ctx.workspace;
  const loaded = getSettings().workspace;
  if (!loaded) throw new Error("Active workspace is not configured");
  return loaded;
}

function sanitizeProject(project: string): string {
  const clean = project.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  if (!clean || clean === "." || clean === "..") throw new Error("invalid project name");
  return clean;
}

export interface WikiRouteContext {
  workspace?: string;
  ollama?: WikiModelClient;
  model?: string;
}

export async function handleWikiRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: WikiRouteContext,
): Promise<boolean> {
  if (!p.startsWith("/api/wiki")) return false;

  try {
    if (p === "/api/wiki" && req.method === "GET") {
      const wikis = listWikiProjects().map((project) => {
        const index = readWikiIndex(project);
        return {
          project,
          generatedAt: index?.generatedAt ?? null,
          pages: (index?.pages ?? []).map((page) => ({ title: page.title, slug: page.slug, parent: page.parent })),
        };
      });
      sendJson(res, 200, { wikis });
      return true;
    }

    const match = /^\/api\/wiki\/([^/]+)(?:\/([^/]+))?$/.exec(p);
    if (!match) return false;
    const project = sanitizeProject(decodeURIComponent(match[1]!));
    const slug = match[2] ? decodeURIComponent(match[2]) : null;

    if (slug === "generate" && req.method === "POST") {
      if (!ctx?.ollama) {
        sendJson(res, 409, { error: "Model client is not available in this session" });
        return true;
      }
      const workspace = resolveWorkspace(ctx);
      const index = await generateWiki({
        workspace,
        project,
        model: ctx.model ?? "wiki",
        client: ctx.ollama,
      });
      sendJson(res, 200, { wiki: index });
      return true;
    }

    const index = readWikiIndex(project);
    if (!index) {
      sendJson(res, 404, { error: `no wiki for project "${project}"` });
      return true;
    }

    if (!slug) {
      sendJson(res, 200, {
        project,
        generatedAt: index.generatedAt,
        pages: index.pages.map((page) => ({ title: page.title, slug: page.slug, parent: page.parent, purpose: page.purpose })),
      });
      return true;
    }

    const page = index.pages.find((pg) => pg.slug === slug || pg.title === slug);
    if (!page) {
      sendJson(res, 404, { error: `no page "${slug}" in wiki "${project}"` });
      return true;
    }
    sendJson(res, 200, { page });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, /not configured|invalid project/.test(message) ? 400 : 500, { error: message });
    return true;
  }
}

/** Absolute path of a wiki page file, for callers that stream raw markdown. */
export function wikiPageFile(project: string, slug: string): string {
  return `${wikiRoot(project)}/${slug}.md`;
}
