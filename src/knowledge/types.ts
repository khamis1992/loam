/**
 * Neo N3: the Knowledge Garden data model.
 *
 * A "base" is a named collection of "seeds". A seed is one retrievable unit of
 * knowledge: a title, a body, free-form tags, optional provenance and an
 * optional embedding vector. Everything the rest of the module persists fits in
 * this file, so a base can be serialized to one JSON document and back without
 * a schema migration step.
 *
 * The types are deliberately storage-shaped (flat, JSON-friendly) because the
 * store keeps each base as one entity row in the existing `entities` table.
 */

/** Where a seed came from. Mirrors the D11 memory provenance vocabulary. */
export type KnowledgeProvenanceSource =
  | "user_text"
  | "file"
  | "url"
  | "image_ocr"
  | "node"
  | "agent";

/** Provenance for one seed: enough to answer "where did this come from?". */
export interface KnowledgeProvenance {
  source: KnowledgeProvenanceSource;
  /** Workspace-relative file path, URL, or run node id when known. */
  ref?: string;
  /** Run/task id that produced the seed. */
  runId?: string;
  /** How the seed was produced ("llm_smart" or "fixed"). */
  split?: "llm_smart" | "fixed";
  /** N13: node kind the seed was captured from (`document`, `webpage`, `kb_seed`). */
  nodeType?: string;
  /** N13: which captured node version the seed was taken from. */
  nodeVersion?: number;
}

/** One retrievable unit of knowledge. */
export interface KnowledgeSeed {
  id: string;
  /** Short human title; also indexed for retrieval. */
  title: string;
  /** The retrievable text. */
  body: string;
  /** Free-form labels; a tag match is a strong retrieval signal. */
  tags: string[];
  /** Optional normalized embedding (base64 Float32) for the vector channel. */
  vector?: string;
  /** Embedding dimension, recorded so the vector can be decoded safely. */
  dim?: number;
  /** Embedding model name, for honesty about which space the vector lives in. */
  model?: string;
  createdAt: string;
  updatedAt: string;
  provenance?: KnowledgeProvenance;
  /** True when the seed came from the LLM smart splitter (vs fixed chunking). */
  smartSplit?: boolean;
}

/** A named collection of seeds. */
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  seeds: KnowledgeSeed[];
}

/** How a base is scoped: one base per workspace, or one per run. */
export type KnowledgeScope = "workspace" | "run";

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  seeds: number;
}

export interface KnowledgeSearchHit {
  seedId: string;
  baseId: string;
  title: string;
  body: string;
  tags: string[];
  /** Final hybrid score, higher is better. */
  score: number;
  /** Lexical component (tag + term overlap, deterministic). */
  lexical: number;
  /** Vector cosine component, or null when no vector channel was available. */
  vector: number | null;
  /** Terms from the query that matched this seed. */
  matched: string[];
}

export interface KnowledgeSearchResult {
  query: string;
  hits: KnowledgeSearchHit[];
  /** True when nothing scored above zero. */
  empty: boolean;
  /** Which channels contributed: lexical always, vector when available. */
  mode: "lexical" | "hybrid";
}

/** Options for importing content into a base. */
export interface KnowledgeImportOptions {
  baseId?: string;
  /** Base name to create/use when no baseId is given. */
  baseName?: string;
  tags?: string[];
  /** Split mode: "llm" (smart, falls back to fixed) or "fixed". */
  split?: "llm" | "fixed";
  provenance?: KnowledgeProvenance;
  signal?: AbortSignal;
}

export interface KnowledgeImportResult {
  baseId: string;
  baseName: string;
  seeds: KnowledgeSeed[];
  /** True when the LLM smart splitter ran; false when the fixed fallback was used. */
  smartSplit: boolean;
  warnings: string[];
}
