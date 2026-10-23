/**
 * The knowledge base behind the KB-grounded fixtures.
 *
 * The Neo programme wants answers grounded in a knowledge base rather than in
 * the model's prior. This module is deliberately tiny: an in-process store of
 * seeded documents with a deterministic, non-semantic lookup (tag + term
 * overlap). It exists so the gate can measure *whether the agent cited the
 * right seed* without shipping a vector database or calling an embedding model.
 *
 * The retrieval contract is explicit and stable: {@link KnowledgeStore.search}
 * returns seeds ranked by term overlap, and every hit carries the seed id that
 * the citation scorer expects to see in the agent's answer.
 */
import type { NeoSeed } from "./types.js";

export interface KnowledgeHit {
  id: string;
  score: number;
  /** The terms from the query that matched this seed. */
  matched: string[];
}

export interface KnowledgeResult {
  query: string;
  hits: KnowledgeHit[];
  /** True when nothing scored above zero. */
  empty: boolean;
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Terms that carry no retrieval signal in either supported language. */
const STOP_TERMS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "this", "that", "these", "those", "it", "as",
  "at", "by", "from", "ما", "في", "على", "من", "إلى", "عن", "that", "هذا",
  "هذه", "ذلك", "التي", "الذي", "هو", "هي", "كان", "كانت", "لا", "لم", "لن",
]);

/** Extract the meaningful terms of a query, deduplicated, length >= 2. */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const raw of normalize(query).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_TERMS.has(raw)) continue;
    terms.add(raw);
  }
  return [...terms];
}

/**
 * A small deterministic knowledge base.
 *
 * Scoring is term overlap with a tag bonus. It is intentionally not semantic:
 * the gate measures citation accuracy, not retrieval quality, and a stable
 * score keeps the baseline reproducible.
 */
export class KnowledgeStore {
  private readonly seeds = new Map<string, NeoSeed>();

  constructor(seeds: readonly NeoSeed[] = []) {
    for (const seed of seeds) {
      if (!seed.id.trim()) throw new Error("KnowledgeStore: seed id must be non-empty");
      if (this.seeds.has(seed.id)) throw new Error(`KnowledgeStore: duplicate seed id ${seed.id}`);
      this.seeds.set(seed.id, seed);
    }
  }

  get size(): number {
    return this.seeds.size;
  }

  ids(): string[] {
    return [...this.seeds.keys()];
  }

  get(id: string): NeoSeed | undefined {
    return this.seeds.get(id);
  }

  /** Deterministic ranked retrieval over the seeded documents. */
  search(query: string, limit = 5): KnowledgeResult {
    const terms = queryTerms(query);
    if (terms.length === 0) return { query, hits: [], empty: true };
    const scored: KnowledgeHit[] = [];
    for (const seed of this.seeds.values()) {
      const haystack = normalize(`${seed.title} ${seed.body} ${(seed.tags ?? []).join(" ")}`);
      const matched = terms.filter((term) => haystack.includes(term));
      if (matched.length === 0) continue;
      // Tag matches weigh more: a seed tagged with the term is the obvious source.
      const tagBonus = (seed.tags ?? []).filter((tag) => terms.includes(normalize(tag))).length * 2;
      scored.push({ id: seed.id, score: matched.length + tagBonus, matched });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const hits = scored.slice(0, Math.max(1, limit));
    return { query, hits, empty: hits.length === 0 };
  }

  /** The single best seed for a query, or undefined. */
  best(query: string): KnowledgeHit | undefined {
    return this.search(query, 1).hits[0];
  }
}

/**
 * Extract seed ids cited by an answer.
 *
 * The convention the fixtures use is an explicit marker so citation accuracy is
 * measurable without guessing: `[seed:ID]`. A bare id in prose does not count,
 * which is the point — an unmarked assertion is not a citation.
 */
const CITATION_PATTERN = /\[seed:([A-Za-z0-9._-]+)\]/g;

export function extractCitations(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const id = match[1]!;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** True when every cited id exists in `store`. */
export function citationsAreKnown(text: string, store: KnowledgeStore): boolean {
  const ids = extractCitations(text);
  return ids.length > 0 && ids.every((id) => store.get(id) !== undefined);
}
