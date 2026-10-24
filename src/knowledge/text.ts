/**
 * Neo N21: shared text utilities for the Knowledge Garden.
 *
 * Retrieval is bilingual (English and Arabic) and must be deterministic, so
 * tokenization, normalization and sentence splitting live in one place that both
 * the lexical scorer and the splitter use. Nothing here touches the network or
 * the filesystem.
 *
 * Normalization is script-aware because Arabic spelling is not canonical: the
 * same word is routinely written with ta marbuta (ة) or ha (ه), with alef
 * maksura (ى) or yaa (ي), with a hamza-carrying alef (أ إ آ) or a plain alef,
 * and with the Persian yaa (ی) in imported text. A query and a seed must land on
 * one term, so all of those are folded before matching. Diacritics and the
 * tatweel are presentation and are dropped.
 */

/**
 * Arabic spelling variants folded to one canonical letter, applied after NFKC so
 * the presentation forms (U+FE80..) are already canonical. Order matters: the
 * ta marbuta and the maksura go first, then every hamza carrier.
 */
const ARABIC_FOLDS: Array<[RegExp, string]> = [
  // ta marbuta -> ha, alef maksura -> yaa, the Persian yaa -> Arabic yaa
  [/ة/g, "ه"],
  [/ى/g, "ي"],
  [/ی/g, "ي"],
  // every hamza carrier -> bare alef (or the letter the hamza sits on)
  [/آ/g, "ا"],
  [/أ/g, "ا"],
  [/إ/g, "ا"],
  [/ؤ/g, "و"],
  [/ئ/g, "ي"],
  // NOTE: a bare hamza is deliberately NOT folded to alef. Folding it makes
  // the carrier letters collapse onto words they only share a shape with
  // (الميناء "port" -> "المينا", which then stops matching), so a hamza on the
  // line stays itself.
];

/** Terms that carry no retrieval signal in either supported language. */
const STOP_TERMS = new Set([
  // English
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "this", "that", "these", "those", "it", "as",
  "at", "by", "from", "but", "not", "no", "do", "does", "did", "has", "have",
  "what", "which", "who", "how", "why", "when", "where", "than", "then", "into",
  // Arabic (common particles/pronouns). Written in their folded form, which is
  // what `normalizeText` produces, so the comparison is exact: a query written
  // with hamza (إلى، إلى، إن) folds onto the same key as the seed written with a
  // plain alef.
  "ما", "في", "علي", "من", "الي", "عن", "هذا", "هذه", "ذلك", "التي", "الذي",
  "هو", "هي", "كان", "كانت", "لا", "لم", "لن", "قد", "او", "ثم", "ان", "انا",
  "نحن", "انت", "هم", "لها", "له", "مع", "كل", "بعض", "غير", "بين",
  "عند", "اذا", "اي", "كذلك", "بعد", "قبل", "حتي", "بل", "لكن",
]);

/** Arabic diacritics (harakat) and the tatweel, removed before matching. */
const ARABIC_MARKS = /[ً-ٰٟـ]/g;

/** Normalize text for matching: NFKC, strip Arabic marks, fold variants, lowercase. */
export function normalizeText(text: string): string {
  const stripped = text.normalize("NFKC").replace(ARABIC_MARKS, "");
  let folded = stripped;
  for (const [pattern, to] of ARABIC_FOLDS) folded = folded.replace(pattern, to);
  return folded.toLowerCase();
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
 * The dominant script of a piece of text: 'ar' when the Arabic letters outnumber
 * the Latin ones, else 'en'. Empty text is 'en'. Used to pick a reading direction
 * and to keep the two languages' behaviour apart in one place.
 */
export function dominantScript(text: string): "ar" | "en" {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin ? "ar" : "en";
}

/**
 * Extract the meaningful terms of a query. Kept as a named export because the
 * lexical scorer, the smart splitter's fallback and the eval's citation check
 * all need the exact same term set to stay comparable.
 */
export function queryTerms(query: string): string[] {
  return tokenize(query);
}

/**
 * Sentence boundaries for Latin and Arabic text. The Arabic comma (،) is
 * deliberately absent: it separates a phrase, not a sentence, so a run never
 * opens or closes on it. U+06D4 is the Arabic full stop.
 */
const SENTENCE_END = /[.!?؟۔\n]+/;

/** A run of text up to and including its sentence mark. */
export const SPLIT_RUN = /[^.!?؟۔]+[.!?؟۔]*/g;

/**
 * A line that reads as a heading: a markdown ATX heading, or a short line that
 * carries no sentence mark. A line closed by a terminator is a sentence, never a
 * heading, so a paragraph of short Arabic sentences is not mistaken for a list
 * of headings.
 */
export function isHeadingLine(line: string, maxLength = 90): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > maxLength) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  return !/[.!?؟۔]/.test(trimmed);
}

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
