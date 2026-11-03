/**
 * C9 (optional, default off): recency + importance re-ranking of memory hits.
 * Formula and defaults from CrewAI (MIT; memory/types.py:145-185, :350-371):
 *   composite = 0.5 * similarity + 0.3 * 0.5^(ageDays / 30) + 0.2 * importance
 * Own code. Loam's MemoryStore.search (memory/store.ts:245) ranks by cosine only.
 */
export interface RankWeights {
  similarityWeight: number;
  recencyWeight: number;
  importanceWeight: number;
  recencyHalfLifeDays: number;
}

export interface RankableHit {
  score: number;
  entry: { createdAt: string; lastUsedAt?: string; importance?: number; source?: string; kind: string };
}

/** Importance when the entry has none stored: user statements and preferences matter more. */
export function defaultImportance(e: RankableHit["entry"]): number {
  if (typeof e.importance === "number") return Math.min(1, Math.max(0, e.importance));
  if (e.kind === "preference") return 0.7;
  if (e.source === "user") return 0.6;
  return 0.5;
}

export function compositeScore(h: RankableHit, w: RankWeights, now = Date.now()): { score: number; reasons: string[] } {
  const sim = Math.min(1, Math.max(0, h.score));
  const ref = Date.parse(h.entry.lastUsedAt ?? h.entry.createdAt);
  const ageDays = Number.isFinite(ref) ? Math.max(0, (now - ref) / 86_400_000) : 365;
  const decay = Math.pow(0.5, ageDays / w.recencyHalfLifeDays);
  const imp = defaultImportance(h.entry);
  const score = w.similarityWeight * sim + w.recencyWeight * decay + w.importanceWeight * imp;
  const reasons = ["semantic"];
  if (decay > 0.5) reasons.push("recency");
  if (imp > 0.5) reasons.push("importance");
  return { score: Math.round(score * 10_000) / 10_000, reasons };
}

/** Re-ranks `candidates` (fetched with limit * candidateMultiplier) and keeps `limit`. */
export function rerank<H extends RankableHit>(candidates: H[], limit: number, w: RankWeights, now = Date.now()): Array<H & { composite: number; reasons: string[] }> {
  return candidates
    .map((h) => {
      const c = compositeScore(h, w, now);
      return { ...h, composite: c.score, reasons: c.reasons };
    })
    .sort((a, b) => b.composite - a.composite)
    .slice(0, Math.max(1, limit));
}
