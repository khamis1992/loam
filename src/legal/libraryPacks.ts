/**
 * Convert the library's core-law Markdown files (NN_<slug>.md at the library
 * root) into DRAFT `loam-legal-pack/1` packs with provenance
 * `research_snapshot`: searchable through legal_search but never citable as
 * VERIFIED (corpusStore.ts). `verifiedBy` is always left empty — a person
 * upgrades a law to official provenance through the import screen.
 *
 * Articles tagged ملغاة are not imported as current text (listed in
 * `skipped`); articles tagged معدلة keep the text shown on Al Meezan and are
 * reported so a reviewer checks the amendment history.
 */
import type { LegalPack, LegalPackArticle } from "./corpusStore.js";
import type { LegislationType } from "./types.js";
import { parseLabel } from "./normalize.js";

export interface LibraryPackResult {
  file: string;
  pack: LegalPack | null;
  amended: string[];
  skipped: string[];
  warnings: string[];
}

const ARTICLE = /^\*\*مادة\s+([^*]+?)\*\*\s*$/u;

function typeOf(raw: string): LegislationType {
  if (raw.includes("مرسوم بقانون")) return "decree-law";
  if (raw.includes("قرار وزاري")) return "ministerial-decision" as LegislationType;
  if (raw.includes("مرسوم")) return "decree";
  if (raw.includes("قرار أميري")) return "emiri-decision";
  return "law";
}

export function libraryMarkdownToPack(file: string, md: string, retrievedAt: string): LibraryPackResult {
  const out: LibraryPackResult = { file, pack: null, amended: [], skipped: [], warnings: [] };
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
  const meta = (key: string): string => lines.find((l) => l.startsWith(`- ${key}`))?.replace(/^- [^:]+:\s*/, "") ?? "";
  const numYear = meta("الرقم/السنة").match(/(\d+)\s*\/\s*(\d{4})/);
  if (!numYear) { out.warnings.push("no number/year metadata — not a single legislation (pointer file?)"); return out; }
  const kindLine = meta("النوع");
  const publish = meta("تاريخ النشر").match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const gazette = meta("تاريخ النشر").match(/العدد\s+(\d+)/)?.[1];
  const url = lines.find((l) => l.startsWith("- رابط الميزان"))?.match(/https?:\S+/)?.[0];
  const articles: LegalPackArticle[] = [];
  let cur: { label: string; part: "issuance" | "body"; body: string[] } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const text = cur.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text) articles.push({ part: cur.part, label: cur.label, text });
    else out.warnings.push(`article ${cur.label} has no text`);
    cur = null;
  };
  for (const line of lines) {
    const m = line.match(ARTICLE);
    if (m) {
      flush();
      let label = m[1]!.trim();
      const part = /\((إصدار|اصدار)\)/u.test(label) ? "issuance" : "body";
      label = label.replace(/\((إصدار|اصدار)\)/u, "").trim();
      const tags = label.match(/(\s+(ملغا[ةه]|معدل[ةه]?))+$/u)?.[0] ?? "";
      const repealed = /ملغا/u.test(tags);
      const amended = /معدل/u.test(tags);
      label = label.slice(0, label.length - tags.length).trim();
      // "77 (77 مكرراً)" -> "77 مكرراً"; "18 (مكرر)" -> "18 مكرر"; "359 (مكرراً 1)" -> "359 مكرراً 1"
      label = label.replace(/^(\d+)\s*\(\s*(?:\1\s+)?(مكرر[^)]*)\)$/u, "$1 $2").trim();
      if (!parseLabel(label)) out.warnings.push(`unparsed label "${label}"`);
      const id = `${part === "issuance" ? "إصدار " : ""}${label}`;
      if (repealed) { out.skipped.push(id); cur = null; continue; }
      if (amended) out.amended.push(id);
      cur = { label, part, body: [] };
      continue;
    }
    if (/^#{1,3}\s/.test(line)) { flush(); continue; }
    if (cur) cur.body.push(line);
  }
  flush();
  const seen = new Set<string>();
  const unique: LegalPackArticle[] = [];
  for (const a of articles) {
    const k = `${a.part}:${parseLabel(a.label)?.label ?? a.label}`;
    if (seen.has(k)) { out.warnings.push(`duplicate article ${a.label} (${a.part}) dropped — review source`); out.skipped.push(`dup ${a.label}`); continue; }
    seen.add(k); unique.push(a);
  }
  articles.splice(0, articles.length, ...unique);
  if (!articles.length) { out.warnings.push("no articles parsed"); return out; }
  const [, num, year] = numYear;
  out.pack = {
    format: "loam-legal-pack/1",
    legislation: {
      type: typeOf(kindLine || title), year: Number(year), number: Number(num), titleAr: title,
      ...(meta("التصنيف") ? { aliases: [meta("التصنيف")] } : {}),
      ...(publish ? { publishDate: publish } : { issueDate: `${year}-01-01` }),
    },
    source: {
      provenance: "research_snapshot",
      ...(url ? { url } : {}),
      ...(gazette ? { gazetteIssue: gazette } : {}),
      ...(publish ? { gazetteDate: publish } : {}),
      retrievedAt,
    },
    articles,
  };
  return out;
}
