/**
 * Neo N13: "Add to Knowledge Base" from a run node.
 *
 * A document/webpage/`kb_seed` node on the canvas is text the agent produced. This
 * module turns that text into Knowledge Garden seeds (N3) with honest provenance:
 * every seed records `source: "node"`, the node id, the run it belongs to and which
 * version was captured, so a later `kb_search` hit can be traced back to the exact
 * canvas node it came from.
 *
 * The text is split with the N3 pipeline (smart split when a model is wired, fixed
 * fallback otherwise), so a long report becomes several retrievable seeds instead of
 * one unusable block. Nothing is invented: the title comes from the node, and the
 * tags come from the caller (or the node's own tags).
 */
import { ingestContent, type IngestDeps } from "./ingest.js";
import { fixedSplit } from "./splitter.js";
import type { KnowledgeProvenance, KnowledgeSeed } from "./types.js";

/** Optional extras recorded on a node-sourced seed's provenance. */
export interface NodeProvenanceMeta {
  /** Node kind (`document`, `webpage`, `kb_seed`). */
  nodeType?: string;
  /** Which captured version was ingested. */
  nodeVersion?: number;
}

/** What the canvas sends when the user picks "Add to Knowledge Base". */
export interface FromNodeInput {
  /** Run (Loam task) id the node belongs to. */
  runId: string;
  /** The run node id; becomes the seed provenance `ref`. */
  nodeId: string;
  /** Node kind (`document`, `webpage`, `kb_seed`). */
  nodeType?: string;
  /** Node title, used as the base name when none is given. */
  title?: string;
  /** The document text to split. */
  content: string;
  /** Target base id; omitted => create/use `baseName` (or the node title). */
  baseId?: string;
  /** Base name to create/use when no `baseId` is given. */
  baseName?: string;
  /** Extra tags merged onto every seed. */
  tags?: string[];
  /** Split mode; defaults to "llm" (smart, falls back to fixed). */
  split?: "llm" | "fixed";
  /** Which captured version this is; recorded in the provenance. */
  version?: number;
  signal?: AbortSignal;
}

export interface FromNodeResult {
  baseId: string;
  baseName: string;
  seeds: KnowledgeSeed[];
  /** True when the LLM smart splitter ran; false for the fixed fallback. */
  smartSplit: boolean;
  warnings: string[];
}

/** Prefix that keeps node-sourced seeds recognisable in the garden. */
export const NODE_SEED_TAG = "from-node";

/** Build the provenance object a node-sourced seed carries. */
export function nodeProvenance(input: {
  runId: string;
  nodeId: string;
  nodeType?: string;
  version?: number;
}): KnowledgeProvenance {
  return {
    source: "node",
    ref: input.nodeId,
    runId: input.runId,
    split: "fixed",
    ...(input.nodeType ? { nodeType: input.nodeType } : {}),
    ...(input.version !== undefined ? { nodeVersion: input.version } : {}),
  };
}

/**
 * Ingest one node's text into a base.
 *
 * Splits with the N3 pipeline, embeds when an embedder is wired, and stamps every
 * seed with node provenance. A node with no text returns zero seeds with a warning
 * rather than throwing, because the canvas reports it inline instead of failing.
 */
export async function ingestNode(input: FromNodeInput, deps: IngestDeps = {}): Promise<FromNodeResult> {
  const content = (input.content ?? "").trim();
  const baseName = input.baseName?.trim() || input.title?.trim() || "Knowledge Garden";
  const provenance = nodeProvenance({
    runId: input.runId,
    nodeId: input.nodeId,
    ...(input.nodeType ? { nodeType: input.nodeType } : {}),
    ...(input.version !== undefined ? { version: input.version } : {}),
  });

  if (!content) {
    return {
      baseId: input.baseId ?? "",
      baseName,
      seeds: [],
      smartSplit: false,
      warnings: ["nothing to import: the node carries no text"],
    };
  }

  const result = await ingestContent(
    content,
    {
      ...(input.baseId ? { baseId: input.baseId } : {}),
      ...(baseName ? { baseName } : {}),
      tags: [...(input.tags ?? []), NODE_SEED_TAG],
      split: input.split ?? "llm",
      provenance,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    deps,
  );

  // The provenance `split` field is the *seed* splitter's strategy; the pipeline
  // reports which one it used, so keep the record truthful.
  for (const seed of result.seeds) {
    if (seed.provenance) seed.provenance.split = result.smartSplit ? "llm_smart" : "fixed";
  }

  return {
    baseId: result.baseId,
    baseName: result.baseName,
    seeds: result.seeds,
    smartSplit: result.smartSplit,
    warnings: result.warnings,
  };
}

/**
 * Resolve the seeds a node would produce without writing them.
 *
 * Used by the canvas to show "this will create N seeds in base X" before the user
 * confirms, so the action is not a surprise. It runs the same splitter the real
 * ingest uses (fixed, to stay model-free) and returns the titles.
 */
export function previewNodeSeeds(input: FromNodeInput): { title: string; body: string; tags: string[] }[] {
  const content = (input.content ?? "").trim();
  if (!content) return [];
  // A preview must not call a model: the fixed splitter is the honest estimate of
  // how the text will be cut when no smart splitter is available. The tag list is
  // what the real ingest would add, so the preview matches the outcome.
  return fixedSplit(content).map((chunk) => ({
    title: chunk.title,
    body: chunk.body,
    tags: [...(input.tags ?? []), NODE_SEED_TAG, ...chunk.tags],
  }));
}
