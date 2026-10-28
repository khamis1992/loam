/**
 * The anti-fabrication gate. Hard rules (no configuration can relax them):
 *
 *  R1  Every legal authority in a draft is a token ⟦cite:QL-…⟧ (or [[cite:QL-…]])
 *      directly preceded by a verbatim quote in «…» / “…” / "…".
 *  R2  The token id must exist in the local corpus and come from an official,
 *      human-verified source (research snapshots are never citable).
 *  R3  The quote must appear in THAT version's official text (presentation
 *      form). A match that needs orthographic folding passes with a warning.
 *  R4  The version must be in force on the matter's as-of date, unless the
 *      token says |historical, which adds a warning instead.
 *  R5  Every free-text article mention ("المادة 171", "م ٣٠٠", "المادة الخمسون",
 *      "Article 50", "115 مكرراً") outside a verified quote must be backed, in
 *      the previous, same or next sentence, by a verified token for that article.
 *  R6  Every "Law No. N of YYYY" mention must name a legislation that exists in
 *      the corpus; one that is never cited raises a warning.
 *  R7  ⟦ref:QL-…⟧ re-mentions an authority already quoted and verified earlier.
 *
 * Any R1–R7 failure makes the verdict "fail"; a failed draft is never rendered,
 * exported as final, or approved (see review.ts).
 */
import crypto from "node:crypto";
import { renderCitationAr } from "./citation.js";
import type { LegalCorpus } from "./corpusStore.js";
import { orthographicForm, presentationForm } from "./normalize.js";
import { findArticleMentions, findLawMentions, sentenceSpans } from "./references.js";
import { aliasMatches } from "./retrieval.js";
import {
  CITABLE_PROVENANCE,
  type CitationCheck,
  type CitationStatus,
  type ResolvedArticle,
  type SourceProvenance,
  type VerificationReport,
  type VerificationWarning,
} from "./types.js";

export interface VerifyOptions {
  asOf: string;
  /** avids retrieved in this run (legal_search / legal_article). */
  ledger?: ReadonlySet<string>;
  /** Minimum normalized quote length (default 15 characters). */
  minQuoteChars?: number;
  matterKind?: string;
}

export const UNVERIFIED_MARKER = "[غير موثّق — يحتاج بحث محامٍ]";
const TOKEN_RE = /⟦(cite|ref):(QL-[0-9a-f]{10})(\|historical)?⟧|\[\[(cite|ref):(QL-[0-9a-f]{10})(\|historical)?\]\]/g;
const OPENERS: Record<string, string> = { "»": "«", "”": "“", "\"": "\"" };

interface Token {
  kind: "cite" | "ref";
  avid: string;
  historical: boolean;
  start: number;
  end: number;
  raw: string;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const kind = (m[1] ?? m[4]) as "cite" | "ref";
    const avid = (m[2] ?? m[5]) ?? "";
    out.push({ kind, avid, historical: Boolean(m[3] ?? m[6]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw: m[0] });
  }
  return out;
}

/** The quote that ends right before `pos` (whitespace/colon/dash allowed in between). */
export function quoteBefore(text: string, pos: number): { quote: string; start: number; end: number } | null {
  let i = pos - 1;
  while (i >= 0 && /[\s:\-–]/.test(text[i] ?? "")) i--;
  const close = text[i] ?? "";
  const open = OPENERS[close];
  if (!open) return null;
  const startIdx = text.lastIndexOf(open, i - 1);
  if (startIdx < 0 || i - startIdx < 2) return null;
  return { quote: text.slice(startIdx + 1, i), start: startIdx, end: i + 1 };
}

type QuoteResult = "exact" | "orthographic" | "mismatch" | "short";

/** Ordered containment of every ellipsis-separated segment. */
export function matchQuote(quote: string, official: string, minChars: number): QuoteResult {
  const segments = quote.split(/\.{3}|…/).map((seg) => seg.trim()).filter((seg) => seg.length > 0);
  const total = segments.reduce((n, seg) => n + presentationForm(seg).length, 0);
  if (segments.length === 0 || total < minChars) return "short";
  const contains = (form: (t: string) => string): boolean => {
    const hay = form(official);
    let from = 0;
    for (const seg of segments) {
      const needle = form(seg);
      if (!needle) continue;
      const at = hay.indexOf(needle, from);
      if (at < 0) return false;
      from = at + needle.length;
    }
    return true;
  };
  if (contains(presentationForm)) return "exact";
  if (contains(orthographicForm)) return "orthographic";
  return "mismatch";
}

const MSG: Record<CitationStatus, { ar: string; en: string }> = {
  VERIFIED: { ar: "اقتباس مطابق لنص رسمي ساري.", en: "Quote matches an official text in force." },
  VERIFIED_NORMALIZED: { ar: "مطابق بعد توحيد الإملاء (همزات/تاء مربوطة) — راجع النص.", en: "Matches only after orthographic folding — review." },
  QUOTE_MISMATCH: { ar: "الاقتباس لا يطابق نص المادة المستشهد بها.", en: "Quote does not match the cited article text." },
  QUOTE_TOO_SHORT: { ar: "الاقتباس أقصر من أن يُثبت السند.", en: "Quote too short to prove the authority." },
  MISSING_QUOTE: { ar: "استشهاد بلا اقتباس حرفي ملاصق له.", en: "Citation without an adjacent verbatim quote." },
  UNKNOWN_ID: { ar: "معرّف مادة غير موجود في المدوّنة المحلية — يُحتمل أنه مختلق.", en: "Article id not in the local corpus — likely fabricated." },
  UNVERIFIED_SOURCE: { ar: "النص من لقطة بحثية غير رسمية ولا يصلح سنداً.", en: "Text comes from an unofficial research snapshot; not citable." },
  NOT_IN_FORCE_AT_DATE: { ar: "النص غير ساري في تاريخ المسألة.", en: "Text not in force on the matter date." },
  REPEALED: { ar: "المادة ملغاة في تاريخ المسألة.", en: "Article repealed on the matter date." },
  REF_WITHOUT_PRIOR_QUOTE: { ar: "إحالة إلى سند لم يُقتبس ويُتحقق منه قبلها.", en: "Reference to an authority not quoted and verified earlier." },
  UNCITED_ARTICLE_REFERENCE: { ar: "ذِكر مادة بلا استشهاد موثّق لها في الجملة نفسها أو التالية.", en: "Article mentioned without a verified citation nearby." },
  UNKNOWN_LAW_REFERENCE: { ar: "تشريع غير موجود في المدوّنة المحلية — لا يُعتمد.", en: "Legislation not in the local corpus — cannot be relied on." },
};

function check(t: Token | null, index: number, kind: CitationCheck["kind"], status: CitationCheck["status"], span: { start: number; end: number }, extra: Partial<CitationCheck> = {}): CitationCheck {
  const msg = status === "OK" ? { ar: "مُسند.", en: "Backed." } : MSG[status];
  return {
    index, token: t?.raw ?? "", avid: t?.avid ?? null, kind, status, messageAr: msg.ar, messageEn: msg.en, span, ...extra,
  };
}

export function verifyDocument(corpus: LegalCorpus, text: string, opts: VerifyOptions): VerificationReport {
  const minChars = opts.minQuoteChars ?? 15;
  const checks: CitationCheck[] = [];
  const warnings: VerificationWarning[] = [];
  const verifiedAvids = new Set<string>();
  const okTokens: Array<{ start: number; end: number; resolved: ResolvedArticle }> = [];
  const exempt: Array<{ start: number; end: number }> = [];
  const rendered: Array<{ start: number; end: number; replacement: string }> = [];
  const toks = tokens(text);

  toks.forEach((t, index) => {
    exempt.push({ start: t.start, end: t.end });
    const resolved = corpus.resolve(t.avid, opts.asOf);
    const spanOf = { start: t.start, end: t.end };
    if (!resolved) { checks.push(check(t, index, t.kind, "UNKNOWN_ID", spanOf)); return; }
    const provenance = (corpus.provenanceOf(t.avid) ?? "research_snapshot") as SourceProvenance;
    if (!CITABLE_PROVENANCE.has(provenance)) { checks.push(check(t, index, t.kind, "UNVERIFIED_SOURCE", spanOf)); return; }

    if (t.kind === "ref") {
      if (!verifiedAvids.has(t.avid)) { checks.push(check(t, index, "ref", "REF_WITHOUT_PRIOR_QUOTE", spanOf)); return; }
      okTokens.push({ start: t.start, end: t.end, resolved });
      rendered.push({ start: t.start, end: t.end, replacement: `(${renderCitationAr(resolved, corpus, t.historical)})` });
      checks.push(check(t, index, "ref", "OK", spanOf));
      return;
    }

    const q = quoteBefore(text, t.start);
    if (!q) { checks.push(check(t, index, "cite", "MISSING_QUOTE", spanOf)); return; }
    const quoteSpan = { start: q.start, end: t.end };
    const result = matchQuote(q.quote, resolved.version.text, minChars);
    if (result === "short") { checks.push(check(t, index, "cite", "QUOTE_TOO_SHORT", quoteSpan, { quote: q.quote })); return; }
    if (result === "mismatch") {
      const other = corpus.versionsOf(resolved.article.key).find((v) => v.avid !== t.avid && matchQuote(q.quote, v.text, minChars) !== "mismatch");
      const hint = other ? { messageAr: `${MSG.QUOTE_MISMATCH.ar} الاقتباس يطابق نسخة أخرى (${other.avid}) سارية من ${other.effectiveFrom}.`, messageEn: `${MSG.QUOTE_MISMATCH.en} It matches version ${other.avid} (from ${other.effectiveFrom}).` } : {};
      checks.push(check(t, index, "cite", "QUOTE_MISMATCH", quoteSpan, { quote: q.quote, ...hint }));
      return;
    }
    if (!resolved.inForceAt) {
      const repealed = Boolean(resolved.article.repealedAt && resolved.article.repealedAt <= opts.asOf) || resolved.legislation.status === "repealed";
      if (!t.historical) {
        checks.push(check(t, index, "cite", repealed ? "REPEALED" : "NOT_IN_FORCE_AT_DATE", quoteSpan, { quote: q.quote }));
        return;
      }
      warnings.push({ code: "HISTORICAL_CITATION", avid: t.avid, messageAr: "استشهاد بنص سابق (تاريخي) — تأكد أن ذلك مقصود.", messageEn: "Historical text cited — confirm this is intended." });
    }
    const status: CitationStatus = result === "exact" ? "VERIFIED" : "VERIFIED_NORMALIZED";
    if (status === "VERIFIED_NORMALIZED") {
      warnings.push({ code: "ORTHOGRAPHIC_MATCH", avid: t.avid, messageAr: MSG.VERIFIED_NORMALIZED.ar, messageEn: MSG.VERIFIED_NORMALIZED.en });
    }
    const later = resolved.laterVersions.filter((v) => v.effectiveFrom > opts.asOf);
    const closedAfter = resolved.version.effectiveTo !== null && resolved.version.effectiveTo > opts.asOf ? resolved.version.effectiveTo : null;
    const changedFrom = later[0]?.effectiveFrom ?? closedAfter;
    if (changedFrom && !t.historical) {
      warnings.push({ code: "AMENDED_AFTER_DATE", avid: t.avid, messageAr: `عُدّل هذا النص أو أُلغي بعد تاريخ المسألة (اعتباراً من ${changedFrom}).`, messageEn: `This text was amended or repealed after the matter date (from ${changedFrom}).` });
    }
    if (opts.ledger && !opts.ledger.has(t.avid)) {
      warnings.push({ code: "NOT_RETRIEVED_IN_RUN", avid: t.avid, messageAr: "المعرّف لم يُسترجع في هذه المهمة.", messageEn: "Id was not retrieved in this run." });
    }
    verifiedAvids.add(t.avid);
    exempt.push({ start: q.start, end: q.end });
    okTokens.push({ start: q.start, end: t.end, resolved });
    const rendering = renderCitationAr(resolved, corpus, t.historical);
    rendered.push({ start: t.start, end: t.end, replacement: `(${rendering})` });
    checks.push(check(t, index, "cite", status, quoteSpan, { quote: q.quote, rendered: rendering }));
  });

  // ---- free mentions (R5, R6) ----------------------------------------------
  const inExempt = (a: number, b: number): boolean => exempt.some((e) => a >= e.start && b <= e.end);
  const sentences = sentenceSpans(text);
  const windowFor = (pos: number): { start: number; end: number } => {
    const i = sentences.findIndex((sp) => pos >= sp.start && pos < sp.end);
    if (i < 0) return { start: 0, end: text.length };
    const cur = sentences[i] ?? { start: 0, end: text.length };
    const prev = sentences[i - 1];
    const next = sentences[i + 1];
    return { start: prev ? prev.start : cur.start, end: next ? next.end : cur.end };
  };
  const lawMentions = findLawMentions(text).filter((m) => !inExempt(m.start, m.end));
  let freeCount = 0;
  let idx = toks.length;
  for (const m of findArticleMentions(text)) {
    if (inExempt(m.start, m.end)) continue;
    freeCount++;
    const w = windowFor(m.start);
    const windowLaws = lawMentions.filter((l) => l.start >= w.start && l.end <= w.end);
    const aliasLegs = new Set(aliasMatches(corpus, text.slice(w.start, w.end)).map((leg) => leg.key));
    const near = okTokens.filter((t) => t.start < w.end && t.end > w.start);
    const lawOk = (t: { resolved: ResolvedArticle }): boolean => {
      if (windowLaws.length === 0 && aliasLegs.size === 0) return true;
      const leg = t.resolved.legislation;
      return aliasLegs.has(leg.key) || windowLaws.some((l) => l.number === leg.number && l.year === leg.year);
    };
    const missing = m.labels.filter((label) => !near.some((t) => t.resolved.article.label === label && lawOk(t)));
    if (missing.length > 0) {
      checks.push(check(null, idx++, "free_article", "UNCITED_ARTICLE_REFERENCE", { start: m.start, end: m.end }, {
        quote: m.raw,
        messageAr: `${MSG.UNCITED_ARTICLE_REFERENCE.ar} (${missing.join("، ")})`,
        messageEn: `${MSG.UNCITED_ARTICLE_REFERENCE.en} (${missing.join(", ")})`,
      }));
    } else {
      checks.push(check(null, idx++, "free_article", "OK", { start: m.start, end: m.end }, { quote: m.raw }));
    }
  }
  const citedLaws = new Set(okTokens.map((t) => t.resolved.legislation.key));
  for (const l of lawMentions) {
    freeCount++;
    const found = corpus.findByNumberYear(l.number, l.year).filter((leg) => l.type === "other" || leg.type === l.type);
    if (found.length === 0) {
      checks.push(check(null, idx++, "free_law", "UNKNOWN_LAW_REFERENCE", { start: l.start, end: l.end }, { quote: l.raw }));
      continue;
    }
    checks.push(check(null, idx++, "free_law", "OK", { start: l.start, end: l.end }, { quote: l.raw }));
    if (!found.some((leg) => citedLaws.has(leg.key))) {
      warnings.push({ code: "UNCITED_LAW_REFERENCE", messageAr: `ذُكر ${l.raw} دون اقتباس أي مادة منه.`, messageEn: `${l.raw} mentioned without quoting any of its articles.` });
    }
  }

  const failing = checks.filter((c) => c.status !== "OK" && c.status !== "VERIFIED" && c.status !== "VERIFIED_NORMALIZED");
  const markers = text.split(UNVERIFIED_MARKER).length - 1;
  const verdict: VerificationReport["verdict"] = failing.length > 0 ? "fail" : warnings.length > 0 || markers > 0 ? "pass_with_warnings" : "pass";
  let renderedDocument: string | undefined;
  if (verdict !== "fail") {
    renderedDocument = text;
    for (const r of [...rendered].sort((a, b) => b.start - a.start)) {
      renderedDocument = renderedDocument.slice(0, r.start) + r.replacement + renderedDocument.slice(r.end);
    }
  }
  return {
    verdict,
    asOf: opts.asOf,
    checks,
    warnings,
    documentSha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    corpusSnapshotId: corpus.snapshot({ persist: false }).id,
    coverage: corpus.coverage({ asOf: opts.asOf, ...(opts.matterKind ? { matterKind: opts.matterKind } : {}) }),
    ...(renderedDocument !== undefined ? { renderedDocument } : {}),
    counts: {
      cited: toks.length,
      verified: checks.filter((c) => c.status === "VERIFIED" || c.status === "VERIFIED_NORMALIZED").length,
      failed: failing.length,
      freeMentions: freeCount,
      unverifiedMarkers: markers,
    },
  };
}

/** Plain-text report for the tool result / refusal path (Arabic first, English second). */
export function reportToText(r: VerificationReport): string {
  const lines = [`verdict=${r.verdict} asOf=${r.asOf} cited=${r.counts.cited} verified=${r.counts.verified} failed=${r.counts.failed} free=${r.counts.freeMentions} unverifiedMarkers=${r.counts.unverifiedMarkers}`];
  for (const c of r.checks) {
    if (c.status === "OK" || c.status === "VERIFIED") continue;
    lines.push(`- [${c.status}] ${c.token || c.quote || ""} — ${c.messageAr} / ${c.messageEn}`);
  }
  for (const w of r.warnings) lines.push(`! [${w.code}] ${w.avid ?? ""} ${w.messageAr} / ${w.messageEn}`);
  if (r.verdict === "fail") {
    lines.push(
      "REFUSAL: this draft cannot be rendered or exported. For each failure, either (a) call legal_search/legal_article and quote the exact official text with its ⟦cite:ID⟧, or (b) remove the claim, or (c) replace it with " +
        UNVERIFIED_MARKER + ". Never invent an article, a law number or a quote.",
    );
  }
  return lines.join("\n");
}
