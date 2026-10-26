/**
 * Legal Arabic normalization, built on Loam's Knowledge Garden folds
 * (src/knowledge/text.ts `normalizeText`: NFKC, harakat + tatweel removal,
 * alef/hamza/yaa/ta-marbuta folding, lowercase).
 *
 * Added here, because legal text needs them and `normalizeText` does not do them:
 *  - Arabic-Indic (U+0660..0669) and Extended Arabic-Indic / Persian (U+06F0..06F9)
 *    digits folded to ASCII. NFKC does NOT do this, so "المادة ١٧١" and
 *    "المادة 171" would otherwise never meet.
 *  - Quote/punctuation unification for verbatim comparison (« » “ ” „ ' ").
 *  - Ordinal article numbers ("المادة الحادية والعشرون" -> 21).
 *  - "bis" labels ("115 مكرراً", "115 مكرراً (4)", "115 مكرراً/4").
 *  - Light prefix stemming for the lexical index (و/ف/ب/ك/ل + ال).
 *
 * Two comparison forms exist on purpose:
 *  - `presentationForm`: drops only what is presentation (diacritics, tatweel,
 *    whitespace runs, quote style, digit script). A quote that matches here is
 *    VERIFIED.
 *  - `orthographicForm`: presentationForm plus the spelling folds. A quote that
 *    only matches here is VERIFIED_NORMALIZED and raises a warning, because a
 *    hamza or ta-marbuta difference can, rarely, change meaning.
 */
import { normalizeText } from "../knowledge/text.js";

const ARABIC_INDIC_ZERO = 0x0660;
const EXT_ARABIC_INDIC_ZERO = 0x06f0;

/** Fold Arabic-Indic and Persian digits to ASCII. One code unit in, one out, so offsets survive. */
export function foldDigits(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) out += String.fromCharCode(48 + code - ARABIC_INDIC_ZERO);
    else if (code >= EXT_ARABIC_INDIC_ZERO && code <= EXT_ARABIC_INDIC_ZERO + 9) out += String.fromCharCode(48 + code - EXT_ARABIC_INDIC_ZERO);
    else out += text[i] ?? "";
  }
  return out;
}

/** Harakat (U+064B..U+065F), superscript alef (U+0670) and tatweel (U+0640). */
const MARKS = /[\u064B-\u065F\u0670\u0640]/g;
/** Every quote/guillemet style collapses to one ASCII double quote. */
const QUOTES = /[«»“”„‟"'‘’‚‛]/g;
/** Arabic comma/semicolon/question mark to ASCII counterparts. */
const PUNCT: Array<[RegExp, string]> = [[/،/g, ","], [/؛/g, ";"], [/؟/g, "?"], [/[\u2013\u2014]/g, "-"]];
/** Zero-width and bidi control characters that copy/paste leaves behind. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Presentation form: NFKC, invisible controls removed, marks removed, digits
 * folded, quotes and Arabic punctuation unified, whitespace collapsed. No letter
 * is changed, so a quote that matches in this form is the official wording.
 */
export function presentationForm(text: string): string {
  let out = foldDigits(text.normalize("NFKC")).replace(INVISIBLE, "").replace(MARKS, "").replace(QUOTES, "\"");
  for (const [re, to] of PUNCT) out = out.replace(re, to);
  // Brackets around numbers are typographic in Qatari gazette text: "(171)" == "171".
  out = out.replace(/\(\s*(\d+)\s*\)/g, "$1");
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Orthographic form: presentation form plus Loam's spelling folds (alef/hamza/yaa/ta marbuta). */
export function orthographicForm(text: string): string {
  return presentationForm(normalizeText(presentationForm(text)));
}

/** Prefixes stripped by the light stemmer, longest first. */
const PREFIXES = ["وبال", "وكال", "وال", "بال", "كال", "فال", "لل", "ال", "و", "ف", "ب", "ل"];

/** Light prefix stemmer for index terms. Keeps at least 3 letters of stem. */
export function lightStem(token: string): string {
  if (!/[\u0600-\u06FF]/.test(token)) return token;
  for (const prefix of PREFIXES) {
    if (token.startsWith(prefix) && token.length - prefix.length >= 3) return token.slice(prefix.length);
  }
  return token;
}

const STOP = new Set([
  "في", "من", "علي", "الي", "عن", "ان", "او", "ما", "لا", "قد", "هذا", "هذه", "ذلك", "التي", "الذي", "الذين",
  "كل", "مع", "بين", "عند", "اذا", "اي", "ثم", "بعد", "قبل", "حتي", "غير", "وفقا", "طبقا", "به", "بها", "له", "لها",
  "the", "of", "and", "or", "to", "in", "on", "for", "with", "is", "are", "be", "by", "a", "an", "as", "at", "that", "this",
]);

/** Index/query terms: orthographic form, split, stop words dropped, raw + stem forms (deduplicated). */
export function legalTerms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of orthographicForm(text).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.add(raw);
    const stem = lightStem(raw);
    if (stem !== raw && !STOP.has(stem)) out.add(stem);
  }
  return [...out];
}

/** Term frequencies for one document (same term rules as `legalTerms`, counted). */
export function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const raw of orthographicForm(text).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    tf.set(raw, (tf.get(raw) ?? 0) + 1);
    const stem = lightStem(raw);
    if (stem !== raw && !STOP.has(stem)) tf.set(stem, (tf.get(stem) ?? 0) + 1);
  }
  return tf;
}

// ---------------------------------------------------------------------------
// Ordinal numbers (feminine, as used for "المادة"), written in folded form
// ---------------------------------------------------------------------------

const UNITS_FEM: Record<string, number> = {
  "الاولي": 1, "الحاديه": 1, "الثانيه": 2, "الثالثه": 3, "الرابعه": 4, "الخامسه": 5,
  "السادسه": 6, "السابعه": 7, "الثامنه": 8, "التاسعه": 9,
};
const TENS: Record<string, number> = {
  "العشرون": 20, "العشرين": 20, "الثلاثون": 30, "الثلاثين": 30, "الاربعون": 40, "الاربعين": 40,
  "الخمسون": 50, "الخمسين": 50, "الستون": 60, "الستين": 60, "السبعون": 70, "السبعين": 70,
  "الثمانون": 80, "الثمانين": 80, "التسعون": 90, "التسعين": 90,
};

/**
 * Parse an ordinal article number written in words (folded or not). Supports
 * 1..199: "الأولى", "العاشرة", "الحادية عشرة", "الخامسة والعشرون", "المائة",
 * "الحادية بعد المائة", "الخامسة والعشرون بعد المائة". Returns null when the
 * phrase is not an ordinal.
 */
export function parseOrdinal(phrase: string): number | null {
  const words = normalizeText(phrase).replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let hundreds = 0;
  const afterIdx = words.findIndex((w) => w === "بعد");
  let core = words;
  if (afterIdx >= 0) {
    const tail = words.slice(afterIdx + 1).join(" ");
    if (tail === "المايه" || tail === "الماييه" || tail === "الميه" || tail === "المئه") hundreds = 100;
    else return null;
    core = words.slice(0, afterIdx);
  } else if (words.length === 1 && (words[0] === "المايه" || words[0] === "الميه" || words[0] === "المئه")) {
    return 100;
  }
  const value = parseBelowHundred(core);
  if (value === null) return null;
  return hundreds + value;
}

function parseBelowHundred(words: string[]): number | null {
  if (words.length === 1) {
    const w = words[0] ?? "";
    if (w === "العاشره") return 10;
    if (w in UNITS_FEM && w !== "الحاديه") return UNITS_FEM[w] ?? null;
    if (w in TENS) return TENS[w] ?? null;
    return null;
  }
  if (words.length === 2 && (words[1] === "عشره" || words[1] === "عشر")) {
    const unit = UNITS_FEM[words[0] ?? ""];
    return unit !== undefined ? 10 + unit : null;
  }
  if (words.length === 2 && (words[1] ?? "").startsWith("وال")) {
    const unit = UNITS_FEM[words[0] ?? ""];
    const tens = TENS[(words[1] ?? "").slice(1)];
    if (unit !== undefined && tens !== undefined) return tens + unit;
  }
  return null;
}

/** All ordinal phrases this parser knows, longest first, for building the mention regex. */
export function ordinalAlternation(): string {
  const unitWords = Object.keys(UNITS_FEM);
  const parts = [
    "(?:" + unitWords.join("|") + ")\\s+و(?:" + Object.keys(TENS).join("|") + ")",
    "(?:" + unitWords.join("|") + ")\\s+عشر[ه]?",
    "العاشره",
    "(?:" + Object.keys(TENS).join("|") + ")",
    "(?:" + unitWords.filter((w) => w !== "الحاديه").join("|") + ")",
    "(?:الماي?ه|الميه|المئه)",
  ];
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// Article labels ("115", "115 مكرراً", "115 مكرراً (4)", "115 مكرراً/4")
// ---------------------------------------------------------------------------

/** Canonical article label from a number and an optional bis marker + index. */
export function canonicalLabel(num: number, bis: boolean, bisIndex?: number): string {
  if (!bis) return String(num);
  return bisIndex && bisIndex > 0 ? `${num}bis${bisIndex}` : `${num}bis`;
}

/** Parse a raw label as written in a gazette or a draft. Returns null if unparseable. */
export function parseLabel(raw: string): { label: string; ordinal: number } | null {
  const t = normalizeText(foldDigits(raw)).replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(\d+)\s*(مكرر(?:ا|اً)?|bis)?\s*(?:\/\s*|\s)?(\d+)?$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const bis = Boolean(m[2]);
    const idx = m[3] ? Number(m[3]) : undefined;
    if (!bis && idx !== undefined) return null;
    return { label: canonicalLabel(n, bis, idx), ordinal: n };
  }
  const canon = /^(\d+)bis(\d+)?$/.exec(t);
  if (canon) return { label: t, ordinal: Number(canon[1]) };
  const ord = parseOrdinal(t);
  return ord === null ? null : { label: String(ord), ordinal: ord };
}

/** Human Arabic rendering of a canonical label ("115bis4" -> "115 مكرراً (4)"). */
export function renderLabelAr(label: string): string {
  const m = /^(\d+)(bis)?(\d+)?$/.exec(label);
  if (!m) return label;
  if (!m[2]) return m[1] ?? label;
  return m[3] ? `${m[1]} مكرراً (${m[3]})` : `${m[1]} مكرراً`;
}
