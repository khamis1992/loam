/**
 * Neo N3: hybrid search over the Knowledge Garden.
 *
 * Two channels, one deterministic ranking:
 *
 *  1. Lexical: a tag match scores strongly (tags are human-curated), then
 *     term-overlap between the query and the seed title/body. This is the
 *     channel that always works offline and is what makes retrieval reliable for
 *     exact entities, numbers and technical terms.
 *  2. Vector: cosine similarity against each seed's stored embedding, when the
 *     garden has one. It is blended in only when the query vector and the seed
 *     vectors live in the same space, so a missing or mismatched embedder never
 *     silently degrades results.
 *
 * The final score is a weighted blend, so results are reproducible for a given
 * garden state: same seeds + same query => same order. That property is what the
 * N3 acceptance test relies on (the gold seed must land in the top 3).
 */
import { dot, fromBase64 } from "../memory/embeddings.js";
import { normalizeText, queryTerms, tokenize } from "./text.js";
import { allBases } from "./store.js";
import type { KnowledgeBase, KnowledgeSearchHit, KnowledgeSearchResult, KnowledgeSeed } from "./types.js";

export interface SearchOptions {
  /** Restrict to a single base id. */
  baseId?: string;
  /** Maximum hits returned. */
  k?: number;
  /** Optional vector channel: embeds the query and scores stored vectors. */
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  model?: string;
  /** Blend weight for the vector channel when it is available (0..1). */
  vectorWeight?: number;
  signal?: AbortSignal;
}

const TAG_WEIGHT = 3;
const TITLE_WEIGHT = 2;
const BODY_WEIGHT = 1;

function baseList(baseId?: string): KnowledgeBase[] {
  if (baseId) {
    const base = allBases().find((b) => b.id === baseId);
    return base ? [base] : [];
  }
  return allBases();
}

/**
 * Lexical score for one seed. A tag hit dominates; term overlap in the title
 * counts more than in the body. Returns the matched terms so the caller can
 * show why a seed ranked where it did.
 */
export function lexicalScore(seed: KnowledgeSeed, terms: string[]): { score: number; matched: string[] } {
  if (terms.length === 0) return { score: 0, matched: [] };
  const titleTerms = new Set(tokenize(seed.title));
  const bodyTerms = new Set(tokenize(`${seed.title}\n${seed.body}`));
  const tagTerms = new Set(seed.tags.flatMap((tag) => tokenize(tag)));

  let score = 0;
  const matched: string[] = [];
  for (const term of terms) {
    const key = normalizeText(term);
    if (!key) continue;
    let contribution = 0;
    if (tagTerms.has(key)) contribution += TAG_WEIGHT;
    if (titleTerms.has(key)) contribution += TITLE_WEIGHT;
    if (bodyTerms.has(key)) contribution += BODY_WEIGHT;
    if (contribution > 0) {
      score += contribution;
      matched.push(term);
    }
  }
  // Normalize by query length so a long query does not automatically outrank.
  const normalized = terms.length > 0 ? score / terms.length : 0;
  return { score: normalized, matched };
}

/** Cosine similarity when both vectors exist, else null. */
function cosine(query: Float32Array, vector: string | undefined, dim?: number): number | null {
  if (!vector) return null;
  const seed = fromBase64(vector, dim ?? 0);
  if (!seed || seed.length === 0) return null;
  return dot(query, seed);
}

/**
 * Search the garden. Always runs the lexical channel; the vector channel is
 * added only when an embedder is supplied. Results are sorted by descending
 * score, then by seed id, so ties are stable.
 */
export async function searchKnowledge(
  query: string,
  opts: SearchOptions = {},
): Promise<KnowledgeSearchResult> {
  const trimmed = query.trim();
  const terms = queryTerms(trimmed);
  const k = Math.min(Math.max(opts.k ?? 8, 1), 50);

  const queryVector = opts.embedder ? await embedQuery(opts.embedder, trimmed) : undefined;
  const hasVector = queryVector !== undefined && queryVector.length > 0;
  const weight = hasVector ? Math.min(Math.max(opts.vectorWeight ?? 0.4, 0), 1) : 0;
  const q = hasVector ? Float32Array.from(queryVector!) : undefined;

  const hits: KnowledgeSearchHit[] = [];
  for (const base of baseList(opts.baseId)) {
    for (const seed of base.seeds) {
      const lexical = lexicalScore(seed, terms);
      let vector: number | null = null;
      if (hasVector && q && seed.vector) {
        vector = cosine(q, seed.vector, seed.dim);
      }
      let score = lexical.score;
      if (vector !== null) {
        const vec = (vector + 1) / 2; // cosine is -1..1; map to 0..1
        score = (1 - weight) * lexical.score + weight * vec;
      }
      if (score <= 0) continue;
      hits.push({
        seedId: seed.id,
        baseId: base.id,
        title: seed.title,
        body: seed.body,
        tags: seed.tags,
        score: round3(score),
        lexical: round3(lexical.score),
        vector: vector === null ? null : round3(vector),
        matched: lexical.matched,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.seedId.localeCompare(b.seedId));
  const top = hits.slice(0, k);
  return {
    query: trimmed,
    hits: top,
    empty: top.length === 0,
    mode: hasVector ? "hybrid" : "lexical",
  };
}

async function embedQuery(
  embedder: { embed(texts: string[]): Promise<number[][]> },
  query: string,
): Promise<number[] | undefined> {
  try {
    const vectors = await embedder.embed([query]);
    return vectors[0];
  } catch {
    return undefined;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
