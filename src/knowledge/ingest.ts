/**
 * Neo N3: the ingestion pipeline.
 *
 * `ingestContent` is the single entry point every importer path funnels
 * through: extract text -> split into chunks -> persist seeds -> embed them when
 * an embedder is available. It is deliberately tolerant: a source that yields no
 * text still returns a result (with warnings) rather than throwing, because a UI
 * import action should report "nothing to import" instead of erroring out.
 *
 * When no embedder is wired the seeds are stored without vectors and search runs
 * in lexical-only mode. That keeps the feature usable offline while still being
 * honest: the result object reports `vector: false`.
 */
import { toBase64 } from "../memory/embeddings.js";
import { ensureBase, getBase, newSeedId, setSeedVector, upsertSeeds } from "./store.js";
import { fixedSplit, smartSplit, type SmartSplitOptions, type SmartSplitter } from "./splitter.js";
import type { KnowledgeImportOptions, KnowledgeImportResult, KnowledgeSeed } from "./types.js";

export interface IngestDeps {
  /** LLM-backed smart splitter; optional. */
  smartSplitter?: SmartSplitter;
  /** Embedder for the vector channel; optional. */
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  /** Model name recorded on the embedding. */
  model?: string;
  /** Fixed chunk size for the fallback splitter. */
  maxChars?: number;
}

/** The default base a run writes to when none is named. */
export const DEFAULT_BASE_NAME = "Knowledge Garden";
const DEFAULT_BASE_DESCRIPTION = "Workspace knowledge garden";

/**
 * Ingest one block of text into a base. Splits with the smart strategy when
 * requested and available, embeds the resulting seeds, and returns them.
 */
export async function ingestContent(
  text: string,
  opts: KnowledgeImportOptions = {},
  deps: IngestDeps = {},
): Promise<KnowledgeImportResult> {
  const existing = opts.baseId ? getBase(opts.baseId) : undefined;
  const baseName = existing?.name ?? opts.baseName?.trim() ?? DEFAULT_BASE_NAME;
  const { base } = ensureBase(baseName, DEFAULT_BASE_DESCRIPTION, opts.baseId);

  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return { baseId: base.id, baseName: base.name, seeds: [], smartSplit: false, warnings: ["nothing to import: source had no text"] };
  }

  const smartOptions: SmartSplitOptions | undefined = deps.smartSplitter
    ? { model: deps.model ?? "default", signal: opts.signal }
    : undefined;

  const { chunks, usedFallback } =
    opts.split === "fixed"
      ? { chunks: fixedSplit(trimmed, { maxChars: deps.maxChars }), usedFallback: true }
      : await smartSplit(trimmed, deps.smartSplitter, { maxChars: deps.maxChars, smartOptions });

  if (usedFallback && opts.split === "llm") {
    warnings.push("smart_split_fallback: LLM splitter unavailable, used fixed chunking");
  }
  if (chunks.length === 0) {
    return { baseId: base.id, baseName: base.name, seeds: [], smartSplit: false, warnings: [...warnings, "splitter produced no seeds"] };
  }

  const provenance = opts.provenance;
  const seeds: KnowledgeSeed[] = chunks.map((chunk) => ({
    id: newSeedId(),
    title: chunk.title,
    body: chunk.body,
    tags: [...(opts.tags ?? []), ...chunk.tags],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    smartSplit: chunk.smart ?? false,
    // Provenance is nested, not flattened: the seed row keeps one `provenance`
    // object so a reader never has to know which fields belong to it.
    ...(provenance ? { provenance } : {}),
  }));

  const added = upsertSeeds(base.id, seeds);

  if (deps.embedder) {
    try {
      const vectors = await deps.embedder.embed(added.map((s) => `${s.title}\n${s.body}`));
      added.forEach((seed, i) => {
        const vector = vectors[i];
        if (vector && vector.length > 0) {
          setSeedVector(base.id, seed.id, toBase64(vector), vector.length, deps.model);
        }
      });
    } catch {
      warnings.push("embedding_failed: seeds stored without vectors (lexical search only)");
    }
  }

  return {
    baseId: base.id,
    baseName: base.name,
    seeds: added,
    smartSplit: !usedFallback,
    warnings,
  };
}
