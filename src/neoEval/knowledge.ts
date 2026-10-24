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
 *
 * N21: term extraction is shared with the Knowledge Garden, so a fixture written
 * in Arabic retrieves exactly the way the shipped feature does: spelling
 * variants are folded (ta marbuta to ha, hamza carriers to bare alef), Arabic
 * diacritics and the tatweel are dropped, and both languages' stop terms are
 * removed before a match is attempted.
 */
import { normalizeText, queryTerms } from "../knowledge/text.js";
import type { NeoSeed } from "./types.js";

export { queryTerms };

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

/**
 * A small deterministic knowledge base.
 *
 * Scoring is term overlap with a tag bonus. It is intentionally not semantic:
 * the gate measures citation accuracy, not retrieval quality, and a stable
 * score keeps the baseline reproducible. Retrieval is bilingual: the query and
 * the seed are both normalized through the shared `normalizeText`, so the
 * script of a fixture does not have to match the script of the query beyond
 * folding.
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
      const haystack = normalizeText(`${seed.title} ${seed.body} ${(seed.tags ?? []).join(" ")}`);
      const matched = terms.filter((term) => haystack.includes(normalizeText(term)));
      if (matched.length === 0) continue;
      // Tag matches weigh more: a seed tagged with the term is the obvious source.
      const tagBonus = (seed.tags ?? []).filter((tag) => terms.includes(normalizeText(tag))).length * 2;
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
 * which is the point: an unmarked assertion is not a citation.
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
