/**
 * Neo N3: shared text utilities for the Knowledge Garden.
 *
 * Retrieval is bilingual (English and Arabic) and must be deterministic, so
 * tokenization, normalization and sentence splitting live in one place that both
 * the lexical scorer and the splitter use. Nothing here touches the network or
 * the filesystem.
 */

/** Terms that carry no retrieval signal in either supported language. */
const STOP_TERMS = new Set([
  // English
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "this", "that", "these", "those", "it", "as",
  "at", "by", "from", "but", "not", "no", "do", "does", "did", "has", "have",
  "what", "which", "who", "how", "why", "when", "where", "than", "then", "into",
  // Arabic (common particles/pronouns)
  "ما", "في", "على", "من", "إلى", "عن", "هذا", "هذه", "ذلك", "التي", "الذي",
  "هو", "هي", "كان", "كانت", "لا", "لم", "لن", "قد", "أو", "ثم", "إن", "أن",
  "انا", "نحن", "انت", "هم", "لها", "له", "مع", "كل", "بعض", "غير", "بين",
  "عند", "إذا", "أي", "كذلك", "بعد", "قبل", "حتى", "بل", "لكن",
]);

/** Arabic diacritics (harakat) and the tatweel, removed before matching. */
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;

/** Normalize text for matching: NFKC, strip Arabic marks, lowercase. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(ARABIC_MARKS, "").toLowerCase();
}

/** Split text into word/number tokens, deduplicated, length >= 2, stop-terms removed. */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const tokens = new Set<string>();
  for (const raw of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    if (STOP_TERMS.has(raw)) continue;
    tokens.add(raw);
  }
  return [...tokens];
}

/**
 * Extract the meaningful terms of a query. Kept as a named export because the
 * lexical scorer, the smart splitter's fallback and the eval's citation check
 * all need the exact same term set to stay comparable.
 */
export function queryTerms(query: string): string[] {
  return tokenize(query);
}

/** Sentence boundaries for Latin and Arabic text. */
const SENTENCE_END = /[.!?\u061F\u060C\n]+/;

/** Split text into trimmed, non-empty sentences (paragraphs are also separators). */
export function sentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Collapse whitespace runs (including newlines) into single spaces. */
export function oneLine(text: string, max = 0): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (max > 0 && clean.length > max) return `${clean.slice(0, max).trimEnd()}...`;
  return clean;
}

/** Truncate a body to a bounded preview for listings and tool output. */
export function preview(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

/** Clean a free-form tag: trim, collapse whitespace, drop empties, dedupe. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = String(raw).trim().replace(/\s+/g, " ");
    if (!tag) continue;
    const key = normalizeText(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
