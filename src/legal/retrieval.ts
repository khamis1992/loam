/**
 * Hybrid retrieval over the law corpus.
 *
 * Channels (all deterministic for a given corpus + query):
 *  1. Direct reference: "المادة 171 من القانون المدني" / "Article 3 of Law No. 14 of 2004"
 *     resolves straight to the article in force at `asOf`.
 *  2. BM25 over legal-normalized terms (k1 1.2, b 0.75), with `#art:` / `#leg:`
 *     terms so explicit numbers and laws pull their article up.
 *  3. Optional dense vectors (any embedder; OFF unless an approved embedding
 *     model is configured — see Design decision LD-2).
 * Fusion is weighted Reciprocal Rank Fusion (k = 60), then an optional
 * reranker hook (LD-3). Results carry provenance and an in-force flag so the
 * caller can never mistake a historical or unverified text for current law.
 */
import { dot, normalize } from "../memory/embeddings.js";
import { inForce, type LegalCorpus } from "./corpusStore.js";
import { legalTerms, orthographicForm } from "./normalize.js";
import { findArticleMentions, findLawMentions } from "./references.js";
import { CITABLE_PROVENANCE, type ArticleVersion, type Legislation, type SourceProvenance } from "./types.js";

export interface Embedder { embed(texts: string[]): Promise<number[][]> }

export interface Reranker {
  /** Return one score per candidate (higher = better). Must not reorder the input array. */
  score(query: string, candidates: Array<{ avid: string; text: string }>, signal?: AbortSignal): Promise<number[]>;
}

export interface LegalSearchOptions {
  asOf: string;
  k?: number;
  /** Restrict to one legislation key ("law/2004/22"). */
  lawKey?: string;
  /** Include versions not in force at `asOf` (marked historical). */
  includeHistorical?: boolean;
  embedder?: Embedder;
  embedModel?: string;
  reranker?: Reranker;
  signal?: AbortSignal;
}

export interface LegalHit {
  avid: string;
  articleKey: string;
  legKey: string;
  legTitle: string;
  label: string;
  part: "issuance" | "body";
  heading?: string;
  text: string;
  truncated: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "in_force" | "historical" | "not_yet_in_force";
  provenance: SourceProvenance;
  citable: boolean;
  score: number;
  bm25: number;
  vector: number | null;
  reasons: string[];
}

export interface LegalSearchResult {
  query: string;
  asOf: string;
  hits: LegalHit[];
  mode: "lexical" | "hybrid";
  direct: boolean;
  /** True when nothing relevant exists: the caller must not cite anything. */
  noAuthority: boolean;
}

const RRF_K = 60;
const W_LEX = 1.0;
const W_VEC = 0.8;
const W_DIRECT = 10;
const MAX_TEXT = 4000;
const K1 = 1.2;
const B = 0.75;

/** Legislations whose alias appears in the query (orthographic containment). */
export function aliasMatches(corpus: LegalCorpus, query: string): Legislation[] {
  const q = ` ${orthographicForm(query)} `;
  const hits: Legislation[] = [];
  for (const leg of corpus.listLegislations()) {
    for (const alias of leg.aliases) {
      const a = orthographicForm(alias);
      // Generic one-word aliases ("قانون") would match every query, so an alias
      // must be multi-word or at least 8 characters long to count.
      const specific = a.length >= 6 && (a.includes(" ") || a.length >= 8);
      if (specific && q.includes(` ${a}`)) { hits.push(leg); break; }
    }
  }
  return hits;
}

/** Legislations referenced in the query either by number/year or by alias. */
export function lawsInQuery(corpus: LegalCorpus, query: string): Legislation[] {
  const out = new Map<string, Legislation>();
  for (const m of findLawMentions(query)) {
    for (const leg of corpus.findByNumberYear(m.number, m.year)) {
      if (m.type === "other" || leg.type === m.type) out.set(leg.key, leg);
    }
  }
  for (const leg of aliasMatches(corpus, query)) out.set(leg.key, leg);
  return [...out.values()];
}

function statusOf(v: ArticleVersion, asOf: string): LegalHit["status"] {
  if (inForce(v, asOf)) return "in_force";
  return v.effectiveFrom > asOf ? "not_yet_in_force" : "historical";
}

export async function searchLaw(corpus: LegalCorpus, query: string, opts: LegalSearchOptions): Promise<LegalSearchResult> {
  const k = Math.min(Math.max(opts.k ?? 6, 1), 20);
  const asOf = opts.asOf;
  const laws = lawsInQuery(corpus, query);
  const mentions = findArticleMentions(query);
  const labels = new Set(mentions.flatMap((m) => m.labels));

  // ---- 1. direct references ------------------------------------------------
  const direct = new Map<string, string[]>();
  const lawScope = opts.lawKey ? [opts.lawKey] : laws.map((l) => l.key);
  for (const legKey of lawScope) {
    for (const label of labels) {
      for (const part of ["body", "issuance"] as const) {
        const key = `${legKey}:${part}:${label}`;
        const versions = corpus.versionsOf(key);
        const chosen = versions.find((v) => inForce(v, asOf)) ?? (opts.includeHistorical ? versions[versions.length - 1] : undefined);
        if (chosen) direct.set(chosen.avid, [`direct:${legKey}#${label}`]);
      }
    }
  }

  // ---- 2. BM25 ---------------------------------------------------------------
  const terms = legalTerms(query);
  for (const label of labels) terms.push(`#art:${label}`);
  for (const leg of laws) terms.push(`#leg:${leg.key}`);
  const stats = corpus.stats();
  const N = Math.max(stats.versions, 1);
  const avg = stats.avgLen || 1;
  const bm25 = new Map<string, number>();
  for (const term of new Set(terms)) {
    const posts = corpus.postings(term);
    if (posts.length === 0) continue;
    const idf = Math.log(1 + (N - posts.length + 0.5) / (posts.length + 0.5));
    for (const { avid, tf } of posts) {
      const len = corpus.docLen(avid) || avg;
      const part = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (len / avg))));
      bm25.set(avid, (bm25.get(avid) ?? 0) + part);
    }
  }

  // ---- 3. vectors -------------------------------------------------------------
  const vecScore = new Map<string, number>();
  let hybrid = false;
  if (opts.embedder && opts.embedModel) {
    try {
      const [qv] = await opts.embedder.embed([query]);
      if (qv && qv.length > 0) {
        const q = normalize(qv);
        for (const { avid, vec } of corpus.vectorsFor(opts.embedModel)) vecScore.set(avid, dot(q, vec));
        hybrid = vecScore.size > 0;
      }
    } catch {
      hybrid = false; // embedder down: lexical results stay valid, never silently mixed
    }
  }

  // ---- fusion -----------------------------------------------------------------
  const lexRank = [...bm25.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const vecRank = [...vecScore.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 100);
  const fused = new Map<string, number>();
  lexRank.forEach(([avid], i) => fused.set(avid, (fused.get(avid) ?? 0) + W_LEX / (RRF_K + i + 1)));
  vecRank.forEach(([avid], i) => fused.set(avid, (fused.get(avid) ?? 0) + W_VEC / (RRF_K + i + 1)));
  for (const avid of direct.keys()) fused.set(avid, (fused.get(avid) ?? 0) + W_DIRECT);

  const candidates: LegalHit[] = [];
  for (const [avid, score] of fused) {
    const resolved = corpus.resolve(avid, asOf);
    if (!resolved) continue;
    if (opts.lawKey && resolved.legislation.key !== opts.lawKey) continue;
    const status = statusOf(resolved.version, asOf);
    if (status !== "in_force" && !opts.includeHistorical && !direct.has(avid)) continue;
    const provenance = (corpus.provenanceOf(avid) ?? "research_snapshot") as SourceProvenance;
    const text = resolved.version.text;
    const reasons = [...(direct.get(avid) ?? [])];
    if (bm25.has(avid)) reasons.push("lexical");
    if (vecScore.has(avid)) reasons.push("vector");
    if (status !== "in_force") reasons.push(status);
    candidates.push({
      avid,
      articleKey: resolved.article.key,
      legKey: resolved.legislation.key,
      legTitle: resolved.legislation.titleAr,
      label: resolved.article.label,
      part: resolved.article.part,
      ...(resolved.article.heading ? { heading: resolved.article.heading } : {}),
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
      truncated: text.length > MAX_TEXT,
      effectiveFrom: resolved.version.effectiveFrom,
      effectiveTo: resolved.version.effectiveTo,
      status,
      provenance,
      citable: CITABLE_PROVENANCE.has(provenance) && status === "in_force",
      score: Math.round(score * 1e6) / 1e6,
      bm25: Math.round((bm25.get(avid) ?? 0) * 1000) / 1000,
      vector: vecScore.has(avid) ? Math.round((vecScore.get(avid) ?? 0) * 1000) / 1000 : null,
      reasons,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.avid.localeCompare(b.avid));

  let top = candidates.slice(0, Math.max(k, opts.reranker ? 20 : k));
  if (opts.reranker && top.length > 1) {
    try {
      const scores = await opts.reranker.score(query, top.map((h) => ({ avid: h.avid, text: h.text })), opts.signal);
      if (scores.length === top.length) {
        const directFirst = (h: LegalHit): number => (direct.has(h.avid) ? 1 : 0);
        top = top
          .map((h, i) => ({ h, r: scores[i] ?? 0 }))
          .sort((a, b) => directFirst(b.h) - directFirst(a.h) || b.r - a.r || a.h.avid.localeCompare(b.h.avid))
          .map(({ h }) => ({ ...h, reasons: [...h.reasons, "reranked"] }));
      }
    } catch {
      /* reranker failure keeps the fused order */
    }
  }
  top = top.slice(0, k);
  return { query, asOf, hits: top, mode: hybrid ? "hybrid" : "lexical", direct: direct.size > 0, noAuthority: top.length === 0 };
}
