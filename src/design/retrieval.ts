/**
 * Loam UI Kit design registry retrieval (V8).
 *
 * Retrieval entry point for the `ui_examples_search` agent tool. It does not
 * re-implement the registry contract: manifest validation, enumeration and the
 * scoring primitive all live in `src/design/registry.ts` (the single source of
 * truth). This module only adapts that surface to the shape the tool needs:
 *   - loadDesignRegistry: enumerate the vetted blocks as validated records;
 *   - searchDesignBlocks: BM25/IDF ranking with an optional category filter,
 *     language-agnostic tokenization (English and Arabic) and no throw on an
 *     invalid registry (a bad block must not break a run);
 *   - rerankWithEmbeddings: blend lexical and semantic scores over a shortlist.
 *
 * Keeping the registry contract in one place means the tool, the registry tests
 * and the `check:design-registry` gate can never drift apart.
 */

import fs from "node:fs";
import path from "node:path";
import { DESIGN_REGISTRY_DIR } from "../config.js";
import {
  BLOCKS_DIR,
  searchBlocks,
  toBlockHit,
  validateRegistry,
  type BlockHit,
  type BlockRecord,
  type ScoredBlock,
} from "./registry.js";

export { BLOCKS_DIR };
export type { BlockHit, BlockRecord, ScoredBlock };

/** Minimal embedding surface; compatible with OllamaEmbedder.embedOne. */
export interface DesignEmbedder {
  embedOne(text: string): Promise<number[]>;
}

export interface SearchOptions {
  /** Number of hits to return (default 5, clamped to 1..20). */
  k?: number;
  /** Explicit registry directory; defaults to DESIGN_REGISTRY_DIR. */
  dir?: string;
  /** Restrict results to one block category (e.g. "pricing"). */
  category?: string;
  /** Restrict results to LTR (false) or RTL (true) blocks. */
  rtl?: boolean;
}

const DEFAULT_K = 5;
const MAX_K = 20;

/** Blocks directory for a registry root. */
function blocksDirOf(dir: string): string {
  return path.join(dir, "blocks");
}

/**
 * Enumerate the registry as validated records, sorted by id. A missing
 * directory or an invalid registry yields an empty list (never throws), so the
 * tool can degrade gracefully and report "registry not found" itself.
 */
export function loadDesignRegistry(dir: string = DESIGN_REGISTRY_DIR): BlockRecord[] {
  const blocksDir = blocksDirOf(dir);
  if (!fs.existsSync(blocksDir)) return [];
  try {
    const { records, issues } = validateRegistry(blocksDir);
    if (issues.length > 0) return [];
    return records.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

function clampK(k: number | undefined): number {
  if (!Number.isFinite(k)) return DEFAULT_K;
  return Math.max(1, Math.min(MAX_K, Math.round(k as number)));
}

/** Rank blocks for a free-text query (English or Arabic). Never throws. */
export function searchDesignBlocks(query: string, options: SearchOptions = {}): BlockHit[] {
  const dir = options.dir ?? DESIGN_REGISTRY_DIR;
  const blocksDir = blocksDirOf(dir);
  if (!fs.existsSync(blocksDir)) return [];
  let scored: ScoredBlock[];
  try {
    scored = searchBlocks(query, clampK(options.k), blocksDir, {
      ...(options.category ? { category: options.category } : {}),
      ...(options.rtl !== undefined ? { rtl: options.rtl } : {}),
    });
  } catch {
    return [];
  }
  return scored.map((entry) => toBlockHit(entry, blocksDir));
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Compact, searchable text for one block (name/tags/category/intent/description). */
function blockText(hit: BlockHit): string {
  return [hit.name, hit.tags.join(" "), hit.category, hit.intent, hit.description].join(" ");
}

/**
 * Re-rank a shortlist with an embedder. Lexical (BM25) and semantic (cosine)
 * scores are normalized and blended so both signals contribute equally;
 * without an embedder the caller skips this and keeps the lexical order.
 */
export async function rerankWithEmbeddings(
  hits: BlockHit[],
  query: string,
  embedder: DesignEmbedder,
): Promise<BlockHit[]> {
  if (hits.length === 0) return hits;
  const maxScore = Math.max(...hits.map((hit) => hit.score), 1);
  const queryVector = await embedder.embedOne(query);
  const scored = await Promise.all(
    hits.map(async (hit) => {
      const vector = await embedder.embedOne(blockText(hit));
      const semantic = Math.max(0, cosineSimilarity(queryVector, vector));
      const lexical = hit.score / maxScore;
      return { hit, score: 0.5 * lexical + 0.5 * semantic };
    }),
  );
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score: Number(score.toFixed(4)) }));
}
