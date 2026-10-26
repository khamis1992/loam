/**
 * Finding legal references in free text, with offsets into the ORIGINAL text.
 *
 * Detection runs on a folded copy (marks/invisibles removed, digits to ASCII,
 * alef/hamza/yaa/ta-marbuta folded, lowercase) and every folded index maps back
 * to an original index, so a report can point at the exact characters a lawyer
 * must fix. Patterns cover Arabic and English, numerals in any script, ordinal
 * words, "bis" articles and lists/ranges ("المواد من 300 إلى 304").
 */
import { canonicalLabel, ordinalAlternation, parseOrdinal } from "./normalize.js";
import type { LegislationType } from "./types.js";

export interface FoldedText { folded: string; map: number[] }

const MARK = /[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const LETTER_FOLD: Record<string, string> = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي", "ی": "ي", "ؤ": "و", "ئ": "ي" };

/** Fold text for matching while keeping a folded-index -> original-index map. */
export function foldWithMap(text: string): FoldedText {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (MARK.test(ch)) continue;
    const code = ch.charCodeAt(0);
    let out = ch;
    if (code >= 0x0660 && code <= 0x0669) out = String.fromCharCode(48 + code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out = String.fromCharCode(48 + code - 0x06f0);
    else if (LETTER_FOLD[ch]) out = LETTER_FOLD[ch] ?? ch;
    else out = ch.toLowerCase();
    folded += out;
    map.push(i);
  }
  map.push(text.length);
  return { folded, map };
}

export interface ArticleMention {
  labels: string[];           // canonical labels ("171", "115bis4")
  start: number;              // original offsets
  end: number;
  raw: string;
}

export interface LawMention {
  type: LegislationType;
  number: number;
  year: number;
  start: number;
  end: number;
  raw: string;
}

const NUM = String.raw`\(?\s*(\d{1,4})\s*\)?`;
const BIS = String.raw`(?:\s*(مكررا?|bis)\s*(?:\(?\s*/?\s*(\d{1,2})\s*\)?)?)?`;
const ART_WORD = String.raw`(?:[وفبل]?(?:ال|لل)?ماد(?:ه|تين|تان|تي))`;
const ARTS_WORD = String.raw`(?:[وفبل]?(?:ال|لل)?مواد)`;
const ABBR = String.raw`(?<![\p{L}\p{N}])[وف]?م\.?`;
const SEP = String.raw`(?:\s*(?:,|،|و|-|–|الي|حتي|to|and|through)\s*)`;

const RE_SINGLE = new RegExp(String.raw`(?<![\p{L}])(?:${ART_WORD}|${ABBR})\s*(?:رقم\s*)?${NUM}${BIS}`, "gu");
const RE_ORDINAL = new RegExp(String.raw`(?<![\p{L}])${ART_WORD}\s+(${ordinalAlternation()})(?![\p{L}])`, "gu");
const RE_LIST = new RegExp(String.raw`(?<![\p{L}])${ARTS_WORD}\s*(?:رقم\s*|من\s*)?((?:\(?\s*\d{1,4}\s*\)?(?:\s*مكررا?)?${SEP}?)+)`, "gu");
const RE_EN_SINGLE = /\b(?:article|art\.)\s*(?:no\.?\s*)?\(?(\d{1,4})\)?(?:\s*(bis|repeated)\s*\(?(\d{1,2})?\)?)?/giu;
const RE_EN_LIST = /\barticles\s+((?:\(?\d{1,4}\)?(?:\s*(?:,|and|to|through|-)\s*)?)+)/giu;

function bisLabel(n: string | undefined, bis: string | undefined, idx: string | undefined): string {
  return canonicalLabel(Number(n), Boolean(bis), idx ? Number(idx) : undefined);
}

/** Expand "300 الي 304" / "3, 5 and 7" into labels (ranges capped at 60 items). */
function expandList(list: string): string[] {
  const tokens = list.split(/(\d{1,4})/).filter((t) => t.length > 0);
  const labels: string[] = [];
  let prev: number | null = null;
  let pendingRange = false;
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (pendingRange && prev !== null && n > prev && n - prev <= 60) {
        for (let k = prev + 1; k <= n; k++) labels.push(String(k));
      } else labels.push(String(n));
      prev = n;
      pendingRange = false;
    } else if (/(الي|حتي|to|through|-|–)/u.test(tok)) {
      pendingRange = true;
    } else if (/مكرر/u.test(tok) && labels.length > 0) {
      labels[labels.length - 1] = `${labels[labels.length - 1]}bis`;
    }
  }
  return labels;
}

function span(f: FoldedText, start: number, end: number, original: string): { start: number; end: number; raw: string } {
  const s = f.map[start] ?? 0;
  let e = f.map[end] ?? original.length;
  while (e > s && /\s/.test(original[e - 1] ?? "")) e--;
  return { start: s, end: e, raw: original.slice(s, e) };
}

/** Every article mention in `text`, deduplicated by span, in document order. */
export function findArticleMentions(text: string): ArticleMention[] {
  const f = foldWithMap(text);
  const out: ArticleMention[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number): boolean => taken.some(([x, y]) => a < y && b > x);
  const push = (labels: string[], a: number, b: number): void => {
    if (labels.length === 0 || overlaps(a, b)) return;
    taken.push([a, b]);
    out.push({ labels, ...span(f, a, b, text) });
  };
  for (const m of f.folded.matchAll(RE_LIST)) {
    const idx = m.index ?? 0;
    push(expandList(m[1] ?? ""), idx, idx + m[0].length);
  }
  for (const m of f.folded.matchAll(RE_SINGLE)) {
    const idx = m.index ?? 0;
    push([bisLabel(m[1], m[2], m[3])], idx, idx + m[0].length);
  }
  for (const m of f.folded.matchAll(RE_ORDINAL)) {
    const idx = m.index ?? 0;
    const n = parseOrdinal(m[1] ?? "");
    if (n !== null) push([String(n)], idx, idx + m[0].length);
  }
  for (const m of f.folded.matchAll(RE_EN_LIST)) {
    const idx = m.index ?? 0;
    push(expandList(m[1] ?? ""), idx, idx + m[0].length);
  }
  for (const m of f.folded.matchAll(RE_EN_SINGLE)) {
    const idx = m.index ?? 0;
    push([bisLabel(m[1], m[2], m[3])], idx, idx + m[0].length);
  }
  return out.sort((a, b) => a.start - b.start);
}

const AR_LAW_TYPES: Array<[RegExp, LegislationType]> = [
  [/^(?:ال)?مرسوم\s*بقانون$/u, "decree-law"],
  [/^(?:ال)?مرسوم$/u, "decree"],
  [/^(?:ال)?قانون$/u, "law"],
  [/^(?:ال)?قرار\s*(?:ال)?اميري$/u, "emiri-decision"],
  [/^(?:ال)?امر\s*(?:ال)?اميري$/u, "emiri-order"],
  [/^(?:ال)?قرار\s*مجلس\s*(?:ال)?وزراء$/u, "cabinet-decision"],
  [/^(?:ال)?قرار\s*(?:ال)?وزاري$/u, "ministerial-decision"],
  [/^(?:ال)?قرار$/u, "decision"],
];
const RE_AR_LAW = /(?<![\p{L}])(?:[وف]?[بلك]?(?:ال|ل)?)(مرسوم\s*بقانون|مرسوم|قانون|قرار\s*(?:ال)?اميري|امر\s*(?:ال)?اميري|قرار\s*مجلس\s*(?:ال)?وزراء|قرار\s*(?:ال)?وزاري|قرار)\s*(?:[\p{L}]+\s*){0,2}?رقم\s*\(?\s*(\d{1,4})\s*\)?\s*(?:لسنه|لعام|سنه)\s*(\d{4})/gu;
const RE_EN_LAW = /\b(decree[- ]law|law|decree|emiri decision|cabinet decision|ministerial decision)\s+no\.?\s*\(?(\d{1,4})\)?\s+(?:of|for)\s+(\d{4})/giu;
const EN_TYPES: Record<string, LegislationType> = {
  "decree-law": "decree-law", "decree law": "decree-law", law: "law", decree: "decree",
  "emiri decision": "emiri-decision", "cabinet decision": "cabinet-decision", "ministerial decision": "ministerial-decision",
};

/** Every "Law No. N of YYYY" style mention, in document order. */
export function findLawMentions(text: string): LawMention[] {
  const f = foldWithMap(text);
  const out: LawMention[] = [];
  for (const m of f.folded.matchAll(RE_AR_LAW)) {
    const head = (m[1] ?? "").replace(/\s+/g, " ").trim();
    const type = AR_LAW_TYPES.find(([re]) => re.test(head))?.[1] ?? "other";
    const idx = m.index ?? 0;
    out.push({ type, number: Number(m[2]), year: Number(m[3]), ...span(f, idx, idx + m[0].length, text) });
  }
  for (const m of f.folded.matchAll(RE_EN_LAW)) {
    const idx = m.index ?? 0;
    const type = EN_TYPES[(m[1] ?? "").toLowerCase().replace(/\s+/g, " ")] ?? "other";
    out.push({ type, number: Number(m[2]), year: Number(m[3]), ...span(f, idx, idx + m[0].length, text) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Sentence-ish segments (original offsets) used to scope "is this mention cited nearby?". */
export function sentenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\n" || ch === "." || ch === "؟" || ch === "?" || ch === "!" || ch === "؛" || ch === ";") {
      if (ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue; // 1.5
      if (ch === "." && text[i - 1] === "م" && !/\p{L}/u.test(text[i - 2] ?? "")) continue; // "م." abbreviation
      if (ch === "." && /(?:^|[^\p{L}])art$/iu.test(text.slice(Math.max(0, i - 4), i))) continue; // "Art."
      if (i > start) spans.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}
