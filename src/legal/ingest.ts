/**
 * Turn the official text of one legislation (copied by a person from the
 * Official Gazette PDF or from Al Meezan) into a DRAFT LegalPack.
 *
 * It never sets `source.verifiedBy`: the import screen shows the split
 * article-by-article and a person must confirm it before `importPack` accepts
 * official provenance. No network access, no crawling (Design decision LD-4).
 *
 * Issuing laws: Qatari codes are typically promulgated by a short issuing law
 * ("قانون رقم (22) لسنة 2004 بإصدار القانون المدني") whose own articles come
 * first, then the code restarts numbering at 1 (OBSERVED for Law 9/2026, which
 * amends Article 2 of the issuing Law 14/2004 separately from the Labour Law's
 * body articles). A restart to article 1 switches `part` from issuance to body.
 */
import { foldDigits, parseLabel } from "./normalize.js";
import type { LegalPack, LegalPackArticle } from "./corpusStore.js";
import type { SourceRef } from "./types.js";

const ARTICLE_LINE = /^\s*(?:ال)?ماد[ةه]\s*[([]?\s*([0-9\u0660-\u0669]+(?:\s*مكرر(?:اً|ا|ًا)?(?:\s*[(/]?\s*[0-9\u0660-\u0669]+\s*\)?)?)?|[\u0621-\u064A\s]{3,40}?)\s*[)\]]?\s*(?:[:：\-–—]\s*(.*))?$/u;
const STRUCTURE_LINE = /^\s*(?:الكتاب|الباب|الفصل|الفرع|القسم)\s+\S+/u;
const PAGE_NOISE = /^\s*[-–—]?\s*[0-9\u0660-\u0669]{1,4}\s*[-–—]?\s*$/u;

export interface DraftPackResult {
  pack: LegalPack;
  warnings: string[];
}

export interface ParsedArticle extends LegalPackArticle { line: number }

export function splitArticles(raw: string): { articles: ParsedArticle[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const articles: ParsedArticle[] = [];
  let current: { part: "issuance" | "body"; label: string; line: number; heading?: string; body: string[] } | null = null;
  let part: "issuance" | "body" = "issuance";
  let sawRestart = false;
  let lastOrdinal = 0;
  let pendingHeading: string[] = [];
  const flush = (): void => {
    if (!current) return;
    const text = current.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) warnings.push(`line ${current.line}: article ${current.label} has no text`);
    articles.push({ part: current.part, label: current.label, text, line: current.line, ...(current.heading ? { heading: current.heading } : {}) });
    current = null;
  };
  for (const [idx, line] of lines.entries()) {
    const lineNo = idx + 1;
    if (PAGE_NOISE.test(line)) continue;
    if (STRUCTURE_LINE.test(line)) {
      flush();
      pendingHeading = [line.trim()];
      continue;
    }
    const m = ARTICLE_LINE.exec(line);
    const parsed = m ? parseLabel((m[1] ?? "").trim()) : null;
    if (m && parsed) {
      flush();
      if (parsed.ordinal === 1 && lastOrdinal >= 1 && !sawRestart) {
        sawRestart = true;
        part = "body";
      } else if (parsed.ordinal < lastOrdinal && parsed.ordinal !== 1) {
        warnings.push(`line ${lineNo}: article ${parsed.label} after ${lastOrdinal} (numbering goes backwards)`);
      }
      lastOrdinal = parsed.ordinal;
      current = { part, label: (m[1] ?? "").trim(), line: lineNo, body: [], ...(pendingHeading.length ? { heading: pendingHeading.join(" — ") } : {}) };
      pendingHeading = [];
      const rest = (m[2] ?? "").trim();
      if (rest) current.body.push(rest);
      continue;
    }
    if (pendingHeading.length > 0 && !current && line.trim()) {
      if (line.trim().length <= 80) { pendingHeading.push(line.trim()); continue; }
    }
    if (current) current.body.push(line);
    else if (line.trim()) warnings.push(`line ${lineNo}: text before the first article was ignored (preamble)`);
  }
  flush();
  if (!sawRestart) for (const a of articles) a.part = "body";
  const seen = new Map<string, number>();
  for (const a of articles) {
    const k = `${a.part}:${parseLabel(a.label)?.label ?? a.label}`;
    const prev = seen.get(k);
    if (prev !== undefined) warnings.push(`line ${a.line}: duplicate article ${k} (first at line ${prev})`);
    else seen.set(k, a.line);
  }
  if (articles.length === 0) warnings.push("no article headings found");
  return { articles, warnings };
}

export function draftPackFromText(
  legislation: LegalPack["legislation"],
  source: Omit<SourceRef, "verifiedBy">,
  raw: string,
): DraftPackResult {
  const { articles, warnings } = splitArticles(raw);
  if (!legislation.effectiveDate) warnings.push("effectiveDate not set: it defaults to publishDate; confirm the in-force date stated in the final article (\"يُعمل به من تاريخ ...\")");
  if (/يعمل به|يُعمل به/u.test(raw) && /بعد\s+[0-9\u0660-\u0669]+|بعد\s+(?:ثلاثين|ستين|تسعين|ستة)\s/u.test(foldDigits(raw))) {
    warnings.push("the text sets a delayed in-force date (\"يُعمل به بعد ...\"): compute effectiveDate from the publication date");
  }
  return {
    pack: {
      format: "loam-legal-pack/1",
      legislation,
      source: { ...source },
      articles: articles.map(({ line: _line, ...a }) => a),
    },
    warnings,
  };
}
