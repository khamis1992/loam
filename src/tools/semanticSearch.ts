import path from "node:path";
import { isInside } from "../policy/paths.js";
import { CodeIndex, type SearchHit } from "../memory/codeIndex.js";
import type { Tool, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

export interface SemanticSearchOptions {
  /** Embedder to use; when omitted the index scores with BM25. */
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  /** Embedding model name recorded in the index. */
  model?: string;
  /** Directory holding the SQLite index (defaults to `<workspace>/.loam`). */
  indexDir?: string;
}

/** Cache one open index per (indexDir, embedder identity) for the process. */
const cache = new Map<string, CodeIndex>();

function indexKey(indexDir: string, embedder: unknown): string {
  return `${indexDir}::${embedder ? "vec" : "bm25"}`;
}

export function resolveIndexDir(workspace: string, opts: SemanticSearchOptions): string {
  const dir = opts.indexDir?.trim() ? path.resolve(opts.indexDir) : path.join(path.resolve(workspace), ".loam");
  return dir;
}

export async function runSemanticSearch(
  workspace: string,
  query: string,
  k: number,
  opts: SemanticSearchOptions = {},
  ctx?: { signal?: AbortSignal },
): Promise<{ ok: boolean; hits: SearchHit[]; mode: string; content: string }> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, hits: [], mode: "none", content: "semantic_search requires a query" };
  const indexDir = resolveIndexDir(workspace, opts);
  if (!isInside(path.resolve(workspace), indexDir)) {
    return { ok: false, hits: [], mode: "none", content: `index directory must stay inside the workspace: ${indexDir}` };
  }
  const key = indexKey(indexDir, opts.embedder);
  let index = cache.get(key);
  if (!index) {
    index = new CodeIndex(workspace, {
      dbPath: path.join(indexDir, "code-index.db"),
      embedder: opts.embedder,
      model: opts.model,
    });
    cache.set(key, index);
  }
  try {
    await index.index({ signal: ctx?.signal });
    const hits = await index.search(trimmed, k);
    const mode = index.scoringMode;
    const content = hits.length === 0
      ? `(no matches for "${trimmed}"; index has ${index.stats().chunks} chunks over ${index.stats().files} files, ${mode})`
      : hits.map((h) => `${h.file}:${h.startLine}-${h.endLine}  (${mode} ${h.score.toFixed(3)})\n  ${h.snippet}`).join("\n\n");
    return { ok: true, hits, mode, content };
  } catch (err) {
    return { ok: false, hits: [], mode: "none", content: `semantic_search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Close and drop every cached index (used by tests and shutdown). */
export function resetSemanticSearchCache(): void {
  for (const index of cache.values()) index.close();
  cache.clear();
}

/** The `semantic_search` agent tool. */
export function createSemanticSearchTools(opts: SemanticSearchOptions = {}): Tool[] {
  return [
    {
      name: "semantic_search",
      description:
        'Answers "where is X handled?" over the indexed project: chunks the source files, embeds them (or falls back to BM25 when no embedding backend is configured), and returns the top file:line ranges with a snippet. Use it instead of repeated file_search when you need to locate a concept or symbol.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Natural-language question, e.g. "where are permissions checked".' },
          k: { type: "number", description: "Max results (default 5, max 20)." },
        },
        required: ["query"],
      },
      async run(args: Record<string, unknown>, ctx): Promise<ToolResult> {
        const k = Math.min(Math.max(num(args, "k", 5), 1), 20);
        const result = await runSemanticSearch(ctx.workspace, str(args, "query"), k, opts, ctx);
        return { ok: result.ok, content: result.content };
      },
    },
  ];
}
