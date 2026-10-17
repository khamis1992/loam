import { cosine } from "./embed.js";
import { clamp } from "./util.js";

export function buildMatchQuery(query: string): string | null {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12);
  const unique = [...new Set(tokens)].filter((t) => t.length > 0);
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function recencyBoost(iso: string, halfLifeDays = 90): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (Date.now() - t) / 86_400_000);
  return 0.05 * Math.exp((-days * Math.LN2) / halfLifeDays);
}

/** Blend a normalized lexical score with an optional embedding similarity. */
export function blendedScore(lex: number, queryVec: Float32Array | null, itemVec: Float32Array | null, createdAtIso: string): number {
  const hasVec = queryVec !== null && itemVec !== null;
  const vecSim = hasVec ? clamp((cosine(queryVec!, itemVec!) + 1) / 2, 0, 1) : 0;
  const base = hasVec ? 0.55 * vecSim + 0.45 * lex : lex;
  return base + recencyBoost(createdAtIso);
}

export function normalizeLexical(relevances: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const r of relevances.values()) if (r > max) max = r;
  const out = new Map<string, number>();
  for (const [id, r] of relevances) out.set(id, max > 0 ? r / max : 0);
  return out;
}

export function lexicalFromRank(rank: unknown): number {
  const r = typeof rank === "number" && Number.isFinite(rank) ? rank : 0;
  return Math.max(0, -r);
}
