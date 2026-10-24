/**
 * Project wiki tools. All of them refuse to run unless `wiki.enabled` is set.
 * Anything read back from the wiki is wrapped as untrusted: earlier sessions
 * wrote it, so it is data, never instructions.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { markUntrusted } from "../policy/riskTier.js";
import { createHandoff, listHandoffs, resolveHandoff } from "../wiki/handoff.js";
import { slugify, wikiRoot } from "../wiki/paths.js";
import { listPages, readPage, writePage } from "../wiki/store.js";
import { search } from "../wiki/wikiIndex.js";
import { PAGE_KINDS, type PageKind } from "../wiki/types.js";

const OFF = "the project wiki is disabled (set wiki.enabled=true in the config to use it)";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const kindOf = (v: unknown): PageKind | undefined => (PAGE_KINDS as readonly string[]).includes(str(v)) ? (str(v) as PageKind) : undefined;

function guarded(name: string, description: string, properties: Record<string, unknown>, required: string[],
  fn: (args: Record<string, unknown>, root: string, ctx: ToolContext) => ToolResult): Tool {
  return {
    name,
    description,
    parameters: { type: "object", additionalProperties: false, required, properties },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.cfg.wiki?.enabled) return { ok: false, content: OFF };
      try {
        return fn(args, wikiRoot(ctx.workspace), ctx);
      } catch (e) {
        return { ok: false, content: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export function createProjectWikiTools(): Tool[] {
  return [
    guarded("wiki_search", "Search this project's wiki (session summaries, lessons, notes, handoffs).",
      { query: { type: "string", minLength: 1 }, kind: { type: "string", enum: [...PAGE_KINDS] }, limit: { type: "number" } }, ["query"],
      (a, root) => {
        const hits = search(root, str(a.query), { limit: Math.min(Number(a.limit) || 8, 20), ...(kindOf(a.kind) ? { kind: kindOf(a.kind)! } : {}) });
        if (!hits.length) return { ok: true, content: "no matching wiki pages" };
        return { ok: true, content: markUntrusted(hits.map((h) => `${h.kind}/${h.id}: ${h.title}\n  ${h.snippet}`).join("\n"), "wiki search") };
      }),
    guarded("wiki_read", "Read one wiki page by kind and id.",
      { kind: { type: "string", enum: [...PAGE_KINDS] }, id: { type: "string", minLength: 1 } }, ["kind", "id"],
      (a, root) => {
        const kind = kindOf(a.kind);
        if (!kind) return { ok: false, content: "unknown page kind" };
        const page = readPage(root, kind, str(a.id));
        if (!page) return { ok: false, content: "page not found" };
        return { ok: true, content: markUntrusted(`# ${page.meta.title}\n\n${page.body}`, `wiki ${kind}/${page.meta.id}`) };
      }),
    guarded("wiki_list", "List wiki pages, optionally of one kind.",
      { kind: { type: "string", enum: [...PAGE_KINDS] } }, [],
      (a, root) => {
        const pages = listPages(root, kindOf(a.kind));
        if (!pages.length) return { ok: true, content: "the wiki has no pages yet" };
        return { ok: true, content: markUntrusted(pages.slice(0, 100).map((p) => `${p.kind}/${p.id}: ${p.title}`).join("\n"), "wiki list") };
      }),
    guarded("wiki_write", "Save a durable project note to the wiki (build commands, conventions, decisions). Secrets are stripped.",
      { title: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, id: { type: "string" }, tags: { type: "array", items: { type: "string" } }, supersedes: { type: "string" } }, ["title", "body"],
      (a, root, ctx) => {
        const title = str(a.title);
        const id = str(a.id) || slugify(title, "note");
        const page = writePage(root, {
          kind: "note", id, title, body: str(a.body),
          tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : [],
          ...(str(a.supersedes) ? { supersedes: str(a.supersedes) } : {}),
          ...(ctx.taskId ? { sessionId: ctx.taskId } : {}),
        });
        return { ok: true, content: `saved note/${page.meta.id}` };
      }),
    guarded("handoff_create", "Leave a handoff for the next session on this project: what is unfinished and where to resume.",
      { title: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 } }, ["title", "body"],
      (a, root, ctx) => {
        const h = createHandoff(root, { title: str(a.title), body: str(a.body), ...(ctx.taskId ? { sessionId: ctx.taskId } : {}) });
        return { ok: true, content: `handoff ${h.id} created` };
      }),
    guarded("handoff_list", "List project handoffs (open ones by default).",
      { state: { type: "string", enum: ["open", "accepted", "dismissed"] } }, [],
      (a, root) => {
        const state = str(a.state);
        const list = listHandoffs(root, state === "accepted" || state === "dismissed" ? state : "open");
        return { ok: true, content: list.length ? markUntrusted(list.map((h) => `${h.id} [${h.state}] ${h.title}`).join("\n"), "handoff list") : "no handoffs" };
      }),
    guarded("handoff_resolve", "Accept or dismiss an open handoff once.",
      { id: { type: "string", minLength: 1 }, to: { type: "string", enum: ["accepted", "dismissed"] } }, ["id", "to"],
      (a, root) => {
        const to = str(a.to) === "dismissed" ? "dismissed" : "accepted";
        return resolveHandoff(root, str(a.id), to)
          ? { ok: true, content: `handoff ${str(a.id)} ${to}` }
          : { ok: false, content: "handoff not found or already resolved" };
      }),
  ];
}
