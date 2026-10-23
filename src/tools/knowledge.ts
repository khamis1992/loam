/**
 * Neo N3: the Knowledge Garden agent tools.
 *
 * Three tools expose the garden to a run:
 *   - `kb_search`  read-only hybrid retrieval; every hit carries its seed id in
 *     the `[seed:ID]` form the citation convention expects.
 *   - `kb_ingest`  import text/file/url into a base (smart split with fixed
 *     fallback), so the agent can grow the garden mid-run.
 *   - `kb_manage`  base CRUD, listing, retagging and deletion.
 *
 * The tools are registered unconditionally in the runtime, but whether they
 * reach a run is decided by the per-run toggle (src/server/runTools.ts): a run
 * without the toggle never sees the names, so the model cannot spend a call on a
 * feature the user switched off.
 */
import type { Tool, ToolResult } from "./registry.js";
import { num, str, strs } from "./registry.js";
import { preview } from "../knowledge/text.js";
import { DEFAULT_BASE_NAME, ingestContent, type IngestDeps } from "../knowledge/ingest.js";
import { searchKnowledge, type SearchOptions } from "../knowledge/search.js";
import {
  deleteBase,
  deleteSeed,
  ensureBase,
  findBaseByName,
  getBase,
  listBases,
  retagSeed,
  updateBase,
  upsertSeed,
} from "../knowledge/store.js";
import { fromFile, fromText, fromUrl, resolveImportPath, type OcrProvider } from "../knowledge/importers.js";
import type { KnowledgeProvenanceSource } from "../knowledge/types.js";

/** The model surface the smart splitter needs (one completion call). */
export interface KnowledgeModelClient {
  chat(opts: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
    signal?: AbortSignal;
  }): Promise<{ content: string }>;
}

export interface KnowledgeToolOptions {
  /** Embedder for the vector channel; omitted => lexical-only retrieval. */
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  /** Model for AI smart split; omitted => always the fixed splitter. */
  smartSplitter?: import("../knowledge/splitter.js").SmartSplitter;
  /** Model name recorded on embeddings and used for the smart split. */
  model?: string;
  /** OCR provider for image imports; omitted => images are reported, skipped. */
  ocr?: OcrProvider;
  /** Fixed chunk size for the fallback splitter. */
  maxChars?: number;
}

const MAX_K = 20;

function depsOf(opts: KnowledgeToolOptions): IngestDeps {
  return {
    ...(opts.smartSplitter ? { smartSplitter: opts.smartSplitter } : {}),
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
  };
}

function provenanceFor(kind: KnowledgeProvenanceSource, ref: string, runId?: string): { source: KnowledgeProvenanceSource; ref: string; runId?: string } {
  return { source: kind, ref, ...(runId ? { runId } : {}) };
}

/** Resolve the base a search should run over; the named base or the default. */
function searchBases(baseId?: string): { baseId?: string } {
  if (baseId) return { baseId };
  const byName = findBaseByName(DEFAULT_BASE_NAME);
  return byName ? { baseId: byName.id } : {};
}

/** Build the garden tool set. */
export function createKnowledgeTools(opts: KnowledgeToolOptions = {}): Tool[] {
  const searchOptionsDefaults: SearchOptions = {
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };

  return [
    {
      name: "kb_search",
      description:
        "Search the Knowledge Garden: the user's own imported documents split into retrievable seeds. Returns ranked seeds with their ids, tags and a preview; cite what you use as [seed:ID]. When NOT to use: the question is about the live project code (use semantic_search/file_search), about long-term memory (memory_search), or about a public fact (web_search). Prefer this when the answer should be grounded in the user's own material.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you need, as search terms in English or Arabic." },
          k: { type: "number", description: `Max seeds (default 5, max ${MAX_K}).` },
          baseId: { type: "string", description: "Restrict to one base id (optional)." },
        },
        required: ["query"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const query = str(args, "query").trim();
        if (!query) return { ok: false, content: "kb_search requires a query" };
        const k = Math.min(Math.max(num(args, "k", 5), 1), MAX_K);
        const { baseId } = searchBases(str(args, "baseId").trim());
        try {
          const result = await searchKnowledge(query, { ...searchOptionsDefaults, baseId, k });
          if (result.empty) {
            return { ok: true, content: `No knowledge seeds match "${query}" (${scopeOf({ baseId })}).` };
          }
          const lines = result.hits.flatMap((hit) => [
            `[seed:${hit.seedId}] score=${hit.score} tags=${hit.tags.join(",") || "none"} title=${hit.title}`,
            `  ${preview(hit.body, 320)}`,
          ]);
          return {
            ok: true,
            content: `Knowledge seeds for "${query}" (${result.mode}, ${scopeOf({ baseId })}):\n${lines.join("\n\n")}`,
            kbSeedIds: result.hits.map((h) => h.seedId),
            kbSeeds: result.hits.map((h) => ({ id: h.seedId, title: h.title, tags: h.tags, preview: preview(h.body, 160) })),
          };
        } catch (err) {
          return { ok: false, content: `kb_search failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "kb_ingest",
      description:
        "Add a document to the Knowledge Garden: splits it into retrievable seeds with tags, so later kb_search can find it. Accepts pasted text, a workspace file path (pdf/md/txt/docx/xlsx/pptx/image) or a web URL. When NOT to use: a quick one-off fact you only need now (just answer), or content already in long-term memory (memory_store). Use it when the user says a source should be remembered or searchable later.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Document text to import (use instead of path/url)." },
          path: { type: "string", description: "Workspace file path to import (e.g. uploads/report.pdf)." },
          url: { type: "string", description: "Web page to fetch and import." },
          baseId: { type: "string", description: "Base id to add to (default: the workspace garden)." },
          baseName: { type: "string", description: "Base name to create/use when no baseId is given." },
          tags: { type: "array", items: { type: "string" }, description: "Tags to add to every seed." },
          mode: { type: "string", description: '"llm" for AI smart split (default) or "fixed" for deterministic chunking.' },
        },
      },
      async run(args: Record<string, unknown>, ctx): Promise<ToolResult> {
        const text = str(args, "text").trim();
        const relPath = str(args, "path").trim();
        const url = str(args, "url").trim();
        const sources = [text.length > 0, relPath.length > 0, url.length > 0].filter(Boolean).length;
        if (sources === 0) return { ok: false, content: "kb_ingest requires text, path or url" };
        if (sources > 1) return { ok: false, content: "kb_ingest takes exactly one of text, path or url" };

        const baseId = str(args, "baseId").trim();
        const baseName = str(args, "baseName").trim() || DEFAULT_BASE_NAME;
        const tags = strs(args, "tags");
        const split = str(args, "mode") === "fixed" ? ("fixed" as const) : ("llm" as const);

        let extracted: { text: string; warnings: string[] };
        let ref: string;
        if (text) {
          extracted = fromText(text);
          ref = "inline";
        } else if (relPath) {
          const abs = resolveImportPath(ctx.workspace, relPath);
          ref = relPath;
          extracted = await fromFile(abs, opts.ocr);
        } else {
          ref = url;
          extracted = await fromUrl(url, undefined, ctx.signal);
        }

        const provenance = provenanceFor(text ? "user_text" : relPath ? "file" : "url", ref, ctx.taskId);
        const result = await ingestContent(extracted.text, { baseId, baseName, tags, split, provenance }, depsOf(opts));

        const warnings = [...extracted.warnings, ...result.warnings];
        const head =
          `Imported ${result.seeds.length} seed(s) into base "${result.baseName}" (${result.baseId})` +
          (result.smartSplit ? " [AI smart split]" : " [fixed split]");
        const body = result.seeds.slice(0, 5).map((s) => `[seed:${s.id}] ${s.title}  tags=${s.tags.join(",") || "none"}`).join("\n");
        return {
          ok: result.seeds.length > 0,
          content: [head, body, ...(warnings.length > 0 ? [`warnings: ${warnings.join("; ")}`] : [])].join("\n"),
          // The garden grew this step; the canvas shows the new seeds.
          kbSeedIds: result.seeds.map((s) => s.id),
          kbSeeds: result.seeds.map((s) => ({ id: s.id, title: s.title, tags: s.tags, preview: preview(s.body, 160) })),
        };
      },
    },
    {
      name: "kb_manage",
      description:
        "Manage the Knowledge Garden itself: list bases and seeds, add a single seed by hand, retag a seed, rename a base, or delete a base/seed. When NOT to use: finding an answer (kb_search) or importing a document (kb_ingest). Use it to keep the garden tidy, correct a tag, or drop something the user removed.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "One of: list, seeds, add_seed, retag, rename, delete_base, delete_seed.",
          },
          baseId: { type: "string", description: "Target base id (list ignores it)." },
          baseName: { type: "string", description: "Base name for create/rename." },
          seedId: { type: "string", description: "Target seed id for retag/delete_seed." },
          title: { type: "string", description: "Seed title for add_seed." },
          body: { type: "string", description: "Seed body for add_seed." },
          tags: { type: "array", items: { type: "string" }, description: "Tags for add_seed or retag." },
        },
        required: ["action"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const action = str(args, "action").trim();
        const baseId = str(args, "baseId").trim();
        try {
          switch (action) {
            case "list": {
              const bases = listBases();
              if (bases.length === 0) return { ok: true, content: "(no knowledge bases yet)" };
              return {
                ok: true,
                content: bases.map((b) => `${b.id}  ${b.name}  (${b.seeds} seeds)`).join("\n"),
              };
            }
            case "seeds": {
              const base = baseId ? getBase(baseId) : findBaseByName(DEFAULT_BASE_NAME);
              if (!base) return { ok: false, content: `no knowledge base for ${baseId || DEFAULT_BASE_NAME}` };
              if (base.seeds.length === 0) return { ok: true, content: `base "${base.name}" is empty` };
              return {
                ok: true,
                content: base.seeds
                  .map((s) => `[seed:${s.id}] ${s.title}  tags=${s.tags.join(",") || "none"}`)
                  .join("\n"),
              };
            }
            case "add_seed": {
              const base = baseId ? getBase(baseId) : ensureBase(DEFAULT_BASE_NAME).base;
              if (!base) return { ok: false, content: `no knowledge base for ${baseId}` };
              const title = str(args, "title").trim();
              const body = str(args, "body").trim();
              if (!body) return { ok: false, content: "add_seed requires a body" };
              const seed = upsertSeed(base.id, {
                id: "",
                title: title || "Untitled",
                body,
                tags: strs(args, "tags"),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
              return { ok: true, content: `added [seed:${seed.id}] "${seed.title}" to base ${base.id}` };
            }
            case "retag": {
              const base = baseId ? getBase(baseId) : findBaseByName(DEFAULT_BASE_NAME);
              if (!base) return { ok: false, content: `no knowledge base for ${baseId || DEFAULT_BASE_NAME}` };
              const seed = retagSeed(base.id, str(args, "seedId"), strs(args, "tags"));
              return { ok: true, content: `retagged [seed:${seed.id}] with ${seed.tags.join(",") || "no tags"}` };
            }
            case "rename": {
              const name = str(args, "baseName").trim();
              if (!baseId || !name) return { ok: false, content: "rename requires baseId and baseName" };
              const base = updateBase(baseId, { name });
              return { ok: true, content: `renamed ${base.id} to "${base.name}"` };
            }
            case "delete_base": {
              if (!baseId) return { ok: false, content: "delete_base requires baseId" };
              const deleted = deleteBase(baseId);
              return { ok: deleted, content: deleted ? `deleted base ${baseId}` : `not found: ${baseId}` };
            }
            case "delete_seed": {
              const base = baseId ? getBase(baseId) : findBaseByName(DEFAULT_BASE_NAME);
              if (!base) return { ok: false, content: `no knowledge base for ${baseId || DEFAULT_BASE_NAME}` };
              const deleted = deleteSeed(base.id, str(args, "seedId"));
              return { ok: deleted, content: deleted ? `deleted seed ${str(args, "seedId")}` : `not found: ${str(args, "seedId")}` };
            }
            default:
              return { ok: false, content: `unknown kb_manage action "${action}"` };
          }
        } catch (err) {
          return { ok: false, content: `kb_manage failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}

/** Human-readable scope of a search, for the tool's own output. */
function scopeOf(opts: { baseId?: string }): string {
  return opts.baseId ? `base=${opts.baseId}` : "all bases";
}
