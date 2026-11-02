import { tokenize } from "./normalize.js";

const K1 = 1.2;
const B = 0.75;

export interface LexicalDoc {
  id: string;
  content: string;
}

export interface LexicalHit {
  id: string;
  score: number;
  rank: number;
}

/** Okapi BM25 over an in-memory corpus. Used when FTS5 is absent and as the rank source. */
export function bm25Rank(docs: readonly LexicalDoc[], query: string): LexicalHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || docs.length === 0) return [];
  const docTokens = docs.map((doc) => tokenize(doc.content));
  const lengths = docTokens.map((tokens) => tokens.length);
  const avg = lengths.reduce((sum, n) => sum + n, 0) / docs.length || 1;
  const df = new Map<string, number>();
  const tfs = docTokens.map((tokens) => {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      if (!seen.has(token)) {
        seen.add(token);
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    return counts;
  });
  const n = docs.length;
  const scored = docs.map((doc, index) => {
    let score = 0;
    const counts = tfs[index]!;
    const dl = lengths[index] ?? 0;
    for (const token of new Set(qTokens)) {
      const tf = counts.get(token) ?? 0;
      if (tf === 0) continue;
      const docsWith = df.get(token) ?? 0;
      const idf = Math.log((n - docsWith + 0.5) / (docsWith + 0.5) + 1);
      const denom = tf + K1 * (1 - B + B * (dl / avg));
      score += idf * ((tf * (K1 + 1)) / denom);
    }
    return { id: doc.id, score };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const hits: LexicalHit[] = [];
  let rank = 0;
  for (const row of scored) {
    if (row.score <= 0) continue;
    hits.push({ id: row.id, score: row.score, rank });
    rank += 1;
  }
  return hits;
}
