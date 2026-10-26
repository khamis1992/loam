/**
 * Clause segmentation and classification for Arabic, English and mixed
 * contracts. Deterministic and local: no model is needed to cut a contract into
 * reviewable units, so confidential text never has to leave the machine for
 * this step. Headings recognised (on a folded copy of each line):
 *   البند (1) / البند الأول / المادة 3 / مادة (٤) / أولاً: / 1. / 1) / Clause 2 / Article 7 / Section 4
 * Sub-numbering (1.1, 2.3) stays inside its parent clause.
 */
import crypto from "node:crypto";
import { foldWithMap } from "../references.js";
import type { Clause, ClauseCategory } from "../types.js";

const MASC_ORDINALS: Record<string, number> = {
  "الاول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4, "الخامس": 5, "السادس": 6, "السابع": 7, "الثامن": 8, "التاسع": 9, "العاشر": 10,
  "الحادي عشر": 11, "الثاني عشر": 12, "الثالث عشر": 13, "الرابع عشر": 14, "الخامس عشر": 15, "السادس عشر": 16,
  "السابع عشر": 17, "الثامن عشر": 18, "التاسع عشر": 19, "العشرون": 20,
  "الاولي": 1, "الثانيه": 2, "الثالثه": 3, "الرابعه": 4, "الخامسه": 5, "السادسه": 6, "السابعه": 7, "الثامنه": 8, "التاسعه": 9, "العاشره": 10,
};
const ADVERB_ORDINALS = ["اولا", "ثانيا", "ثالثا", "رابعا", "خامسا", "سادسا", "سابعا", "ثامنا", "تاسعا", "عاشرا"];
const ORD_ALT = Object.keys(MASC_ORDINALS).sort((a, b) => b.length - a.length).join("|");

const HEADING_PATTERNS: RegExp[] = [
  new RegExp(String.raw`^\s*(?:البند|بند|الماده|ماده|الفقره)\s*(?:رقم\s*)?(?:\(\s*\d{1,3}\s*\)|\d{1,3}|${ORD_ALT})(?![\p{L}\d.])\s*[:\-–.)]?`, "u"),
  new RegExp(String.raw`^\s*(?:${ADVERB_ORDINALS.join("|")})\s*[:\-–.)]`, "u"),
  /^\s*\d{1,2}\s*[.\-–)]\s+\S/u,
  /^\s*(?:clause|article|section)\s+\d{1,3}\b/iu,
];

export function isClauseHeading(line: string): boolean {
  const folded = foldWithMap(line).folded;
  if (/^\s*\d{1,2}\.\d/.test(folded)) return false; // 1.1 sub-clause
  return HEADING_PATTERNS.some((re) => re.test(folded));
}

const LEXICON: Record<Exclude<ClauseCategory, "other">, string[]> = {
  parties: ["الطرف الاول", "الطرف الثاني", "بين كل من", "between", "the parties"],
  definitions: ["التعريفات", "يقصد ب", "definitions", "shall mean"],
  subject: ["موضوع العقد", "محل العقد", "نطاق العمل", "scope of", "subject matter", "purpose of this"],
  price_payment: ["الثمن", "المقابل", "الدفع", "السداد", "الاتعاب", "الاجره", "payment", "fees", "price", "invoice", "rent"],
  term_duration: ["مده العقد", "مدته", "يسري هذا العقد", "يبدا العمل", "term of", "duration", "commencement", "shall commence"],
  termination: ["انهاء", "فسخ", "ينتهي", "termination", "terminate"],
  liability: ["المسووليه", "مسوول", "الحد الاقصي للمسووليه", "liability", "liable"],
  indemnity: ["يعوض", "التعويض عن", "indemnif", "hold harmless"],
  penalty: ["الشرط الجزايي", "غرامه", "غرامات التاخير", "تعويض اتفاقي", "penalty", "liquidated damages"],
  confidentiality: ["السريه", "سري", "عدم الافصاح", "confidential", "non-disclosure"],
  ip: ["الملكيه الفكريه", "حقوق الملكيه", "intellectual property", "copyright"],
  non_compete: ["عدم المنافسه", "عدم منافسه", "لا ينافس", "non-compete", "non compete", "not compete"],
  governing_law: ["القانون الواجب التطبيق", "القانون المطبق", "يخضع هذا العقد", "تسري احكام", "governing law", "governed by"],
  dispute_resolution: ["التحكيم", "تحكيم", "المحاكم المختصه", "محاكم", "تسويه النزاع", "النزاعات", "arbitration", "jurisdiction", "courts of", "dispute"],
  force_majeure: ["القوه القاهره", "قوه قاهره", "force majeure"],
  assignment: ["التنازل عن", "الحواله", "حواله", "assign"],
  notices: ["الاخطارات", "الاشعارات", "المراسلات", "notices"],
  warranties: ["يضمن", "الضمان", "ضمانات", "warrant", "represents and"],
  data_protection: ["حمايه البيانات", "خصوصيه البيانات", "معالجه البيانات", "حمايه خصوصيه", "data protection", "processing of personal data"],
  language: ["اللغه العربيه", "النص العربي", "حرر هذا العقد", "language", "arabic version", "shall prevail"],
};

export function classifyClause(heading: string, text: string): ClauseCategory[] {
  const hay = foldWithMap(`${heading}\n${text}`).folded;
  const head = foldWithMap(heading).folded;
  const scored: Array<{ cat: ClauseCategory; score: number }> = [];
  for (const [cat, words] of Object.entries(LEXICON) as Array<[ClauseCategory, string[]]>) {
    let score = 0;
    for (const w of words) {
      if (head.includes(w)) score += 3;
      else if (hay.includes(w)) score += 1;
    }
    if (score > 0) scored.push({ cat, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const cats = scored.filter((x) => x.score >= Math.max(1, top / 2)).map((x) => x.cat).slice(0, 3);
  return cats.length > 0 ? cats : ["other"];
}

/** Cut a contract into clauses with original offsets. Text before the first heading is clause 0 (preamble). */
export function segmentContract(contractId: string, text: string): Clause[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const marks: Array<{ start: number; heading: string }> = [];
  let pos = 0;
  for (const line of lines) {
    if (line.trim() && isClauseHeading(line)) marks.push({ start: pos, heading: line.trim().slice(0, 160) });
    pos += line.length + 1;
  }
  const norm = text.replace(/\r\n/g, "\n");
  const cuts = marks.length > 0 && (marks[0]?.start ?? 0) > 0 && norm.slice(0, marks[0]?.start ?? 0).trim()
    ? [{ start: 0, heading: "التمهيد" }, ...marks]
    : marks.length > 0 ? marks : [{ start: 0, heading: "النص الكامل" }];
  const clauses: Clause[] = [];
  cuts.forEach((c, i) => {
    const end = i + 1 < cuts.length ? (cuts[i + 1]?.start ?? norm.length) : norm.length;
    const body = norm.slice(c.start, end).trim();
    if (!body) return;
    const id = `cl-${crypto.createHash("sha256").update(`${contractId}|${i}|${body}`).digest("hex").slice(0, 10)}`;
    clauses.push({ id, contractId, index: clauses.length, heading: c.heading, text: body, start: c.start, end, categories: classifyClause(c.heading, body) });
  });
  return clauses;
}

/** Detect the dominant language of a contract. */
export function contractLanguage(text: string): "ar" | "en" | "mixed" {
  const ar = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && en === 0) return "ar";
  const share = ar / (ar + en);
  return share > 0.8 ? "ar" : share < 0.2 ? "en" : "mixed";
}
