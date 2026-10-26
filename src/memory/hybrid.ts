/** Hybrid memory retrieval for Loam's MemoryStore. Ideas from agentmemory (Apache-2.0): BM25 + vector fused with
 *  weighted Reciprocal Rank Fusion, retention decay, per-session diversification. All code new. */

export interface RetrievableEntry {
  id: string; text: string; kind: string; tags: string[]; createdAt: string;
  sessionId?: string; lastUsedAt?: string; useCount?: number; source?: "user" | "agent" | "system";
}

export const RRF_K = 60;
export const WEIGHTS = { bm25: 0.4, vector: 0.6 } as const;
export const AGREEMENT_BONUS = 0.05;          // both retrievers returned the entry
export const MAX_PER_SESSION = 3;
export const RETENTION = { lambdaPerDay: 0.01, sigma: 0.3, hot: 0.7, warm: 0.4, cold: 0.15 } as const;
const SALIENCE: Record<string, number> = { architecture: 0.9, preference: 0.85, pattern: 0.8, bug: 0.7, workflow: 0.6, fact: 0.5, note: 0.5 };

/** Arabic-aware normalisation: drop tashkeel/tatweel, unify alef/yaa/taa-marbuta forms, lowercase Latin. */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, "")
    .replace(/[أإآٱ]/gu, "ا").replace(/ى/gu, "ي").replace(/ة/gu, "ه").replace(/ؤ/gu, "و").replace(/ئ/gu, "ي");
}
export const tokenize = (s: string): string[] => normalizeText(s).match(/[\p{L}\p{N}]{2,}/gu) ?? [];

/** In-memory BM25 (k1 1.2, b 0.75). Rebuilt lazily when the store changes (O(total tokens)). */
export class Bm25Index {
  private docs: Array<{ id: string; tf: Map<string, number>; len: number }> = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  private readonly k1: number;
  private readonly b: number;
  constructor(k1 = 1.2, b = 0.75) { this.k1 = k1; this.b = b; }
  build(entries: RetrievableEntry[]): void {
    this.docs = []; this.df.clear(); let total = 0;
    for (const e of entries) {
      const toks = tokenize(`${e.text} ${e.tags.join(" ")} ${e.kind}`);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: e.id, tf, len: toks.length }); total += toks.length;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
  }
  search(query: string, limit: number): Array<{ id: string; score: number }> {
    const terms = [...new Set(tokenize(query))]; const N = this.docs.length;
    if (!terms.length || !N) return [];
    const out: Array<{ id: string; score: number }> = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of terms) {
        const f = d.tf.get(t); if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (d.len / (this.avgLen || 1)))));
      }
      if (s > 0) out.push({ id: d.id, score: s });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** Retention in [0,1]: salience·e^(−λ·ageDays) + σ·Σ 1/daysSinceAccess (approximated by lastUsedAt). */
export function retentionScore(e: RetrievableEntry, now = Date.now()): { score: number; tier: "hot" | "warm" | "cold" | "evictable" } {
  const day = 86_400_000;
  const age = Math.max(0, (now - Date.parse(e.createdAt)) / day);
  const salience = Math.min(1, (SALIENCE[e.kind] ?? 0.5) + (e.source === "user" ? 0.05 : 0) + Math.min(0.2, 0.02 * (e.useCount ?? 0)));
  const sinceUse = e.lastUsedAt ? Math.max(1, (now - Date.parse(e.lastUsedAt)) / day) : null;
  const reinforcement = sinceUse ? RETENTION.sigma * (1 / sinceUse) : 0;
  const score = Math.min(1, salience * Math.exp(-RETENTION.lambdaPerDay * age) + reinforcement);
  const tier = score >= RETENTION.hot ? "hot" : score >= RETENTION.warm ? "warm" : score >= RETENTION.cold ? "cold" : "evictable";
  return { score: Math.round(score * 1000) / 1000, tier };
}

export interface FusedHit { id: string; score: number; bm25Rank: number | null; vectorRank: number | null; }

/** Weighted RRF, normalised by the maximum attainable score so 1.0 = rank 1 in both lists + agreement bonus. */
export function rrfFuse(bm25: Array<{ id: string }>, vector: Array<{ id: string }>, k = RRF_K): FusedHit[] {
  const m = new Map<string, FusedHit>();
  bm25.forEach((h, i) => m.set(h.id, { id: h.id, score: WEIGHTS.bm25 / (k + i + 1), bm25Rank: i + 1, vectorRank: null }));
  vector.forEach((h, i) => {
    const cur = m.get(h.id) ?? { id: h.id, score: 0, bm25Rank: null, vectorRank: null };
    cur.score += WEIGHTS.vector / (k + i + 1); cur.vectorRank = i + 1; m.set(h.id, cur);
  });
  const max = (WEIGHTS.bm25 + WEIGHTS.vector) / (k + 1) + AGREEMENT_BONUS;
  for (const h of m.values()) { if (h.bm25Rank !== null && h.vectorRank !== null) h.score += AGREEMENT_BONUS; h.score = h.score / max; }
  return [...m.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Keep at most `max` hits per session so one long chat cannot crowd out everything else. */
export function diversify<T extends { id: string }>(hits: T[], sessionOf: (id: string) => string | undefined, max = MAX_PER_SESSION): T[] {
  const seen = new Map<string, number>();
  return hits.filter((h) => { const s = sessionOf(h.id); if (!s) return true; const n = seen.get(s) ?? 0; if (n >= max) return false; seen.set(s, n + 1); return true; });
}

export interface HybridOptions { limit: number; vectorHits: Array<{ id: string; score: number }> | null; retentionWeight?: number; now?: number; }

/** Final score = fused·(1−w) + retention·w (w default 0.15). vectorHits=null → BM25-only (embedder down). */
export function hybridRank(entries: RetrievableEntry[], index: Bm25Index, query: string, opts: HybridOptions) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const pool = Math.max(opts.limit * 4, 20);
  const fused = rrfFuse(index.search(query, pool), (opts.vectorHits ?? []).slice(0, pool));
  const w = opts.retentionWeight ?? 0.15;
  const scored = fused.flatMap((h) => {
    const e = byId.get(h.id); if (!e) return [];
    const r = retentionScore(e, opts.now);
    return [{ ...h, entry: e, retention: r, final: Math.round((h.score * (1 - w) + r.score * w) * 10000) / 10000 }];
  }).sort((a, b) => b.final - a.final);
  return diversify(scored, (id) => byId.get(id)?.sessionId).slice(0, opts.limit);
}
