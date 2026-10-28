/**
 * Document structure checks and the internal cover sheet.
 *
 * Structures follow Khamis's existing legal-memo skill (skills/كتابة-المذكرات-القانونية-الاحترافية,
 * OBSERVED in the repo) for opinions, and the customary Qatari court-memo order
 * (INFERRED, to be confirmed by a licensed lawyer — Design decision LD-10) for
 * defense memoranda. Headings are markdown "## " lines; synonyms are accepted and compared in
 * folded form (hamza, ta marbuta, alef maqsura), so either spelling matches.
 */
import { foldWithMap } from "./references.js";
import { DISCLAIMER_AR } from "./review.js";
import type { Matter, ReviewRecord, VerificationReport } from "./types.js";

export type DocKind = "defense_memo" | "opinion" | "contract_report";

interface SectionSpec { id: string; required: boolean; names: string[] }

export const STRUCTURES: Record<DocKind, SectionSpec[]> = {
  defense_memo: [
    { id: "case", required: true, names: ["بيانات الدعوي", "بيانات القضيه", "الديباجه"] },
    { id: "facts", required: true, names: ["الوقائع", "وقائع الدعوي"] },
    { id: "procedural", required: false, names: ["الدفوع الشكليه", "الدفوع الشكليه والاجراييه", "الدفوع الاجراييه"] },
    { id: "merits", required: true, names: ["الدفاع الموضوعي", "اوجه الدفاع", "الدفوع الموضوعيه", "الدفاع"] },
    { id: "requests", required: true, names: ["الطلبات", "بناء عليه", "لذلك"] },
  ],
  opinion: [
    { id: "summary", required: true, names: ["الخلاصه التنفيذيه", "الخلاصه"] },
    { id: "facts", required: true, names: ["الوقائع"] },
    { id: "issue", required: true, names: ["المساله القانونيه", "المسايل القانونيه"] },
    { id: "framework", required: true, names: ["الاطار القانوني"] },
    { id: "analysis", required: true, names: ["التحليل"] },
    { id: "options", required: false, names: ["الخيارات"] },
    { id: "recommendation", required: true, names: ["التوصيه", "التوصيه والخطوات التاليه"] },
    { id: "caveats", required: true, names: ["التحفظات"] },
    { id: "annexes", required: false, names: ["الملاحق"] },
  ],
  contract_report: [
    { id: "summary", required: true, names: ["الملخص", "الخلاصه"] },
    { id: "table", required: true, names: ["جدول البنود", "جدول المراجعه", "الملاحظات"] },
    { id: "recommendations", required: true, names: ["التوصيات"] },
    { id: "caveats", required: true, names: ["التحفظات"] },
  ],
};

export interface StructureIssue { level: "error" | "warning"; code: string; messageAr: string }

const fold = (s: string): string => foldWithMap(s).folded.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/** Internal artefacts that must never appear in a document for a court or a client. */
const INTERNAL_LEAKS: Array<{ re: RegExp; what: string }> = [
  { re: /⟦|\[\[(?:cite|ref):/u, what: "citation tokens" },
  { re: /QL-[0-9a-f]{10}/u, what: "internal article ids" },
  { re: /[A-Za-z]:\\|\/workspace\/|\.loam-tasks/u, what: "file paths" },
  { re: /\b[0-9a-f]{64}\b/u, what: "sha256 hashes" },
  { re: /\b(?:legal_search|legal_article|legal_cite_check|kb_search|file_read)\b/u, what: "tool names" },
];

export function checkStructure(kind: DocKind, markdown: string): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const headings = markdown.split(/\r?\n/).filter((l) => /^#{1,3}\s+\S/.test(l)).map((l) => fold(l.replace(/^#{1,3}\s+/, "").replace(/^[\d.\-)\s]+/, "")));
  const spec = STRUCTURES[kind];
  const positions: Array<{ id: string; at: number }> = [];
  for (const sec of spec) {
    const names = sec.names.map(fold);
    const at = headings.findIndex((h) => names.some((n) => h === n || h.startsWith(`${n} `)));
    if (at < 0) {
      if (sec.required) issues.push({ level: "error", code: `MISSING_${sec.id.toUpperCase()}`, messageAr: `القسم المطلوب «${sec.names[0]}» غير موجود.` });
    } else positions.push({ id: sec.id, at });
  }
  for (let i = 1; i < positions.length; i++) {
    if ((positions[i]?.at ?? 0) < (positions[i - 1]?.at ?? 0)) {
      issues.push({ level: "warning", code: "ORDER", messageAr: `ترتيب الأقسام غير معتاد: «${positions[i]?.id}» قبل «${positions[i - 1]?.id}».` });
    }
  }
  if (kind !== "defense_memo") {
    const caveats = markdown.split(/^#{1,3}\s+/mu).find((block) => fold(block.split("\n")[0] ?? "").startsWith(fold("التحفظات")));
    if (caveats !== undefined && !fold(caveats).includes(fold("ليست بديلا عن رأي محام مرخص"))) {
      issues.push({ level: "error", code: "DISCLAIMER", messageAr: "قسم التحفظات لا يتضمن التنبيه بأن المخرجات ليست بديلاً عن رأي محامٍ مرخّص." });
    }
  }
  if (kind === "defense_memo" && /مساعد آلي|ذكاء اصطناعي|AI assistant/u.test(markdown)) {
    issues.push({ level: "warning", code: "INTERNAL_NOTE_IN_COURT_TEXT", messageAr: "ملاحظات داخلية أو تنبيه المساعد الآلي في متن مذكرة موجهة للمحكمة؛ مكانها ورقة الغلاف." });
  }
  return issues;
}

/** Leaks are checked on the RENDERED document (after tokens become formal citations). */
export function internalLeaks(rendered: string): StructureIssue[] {
  return INTERNAL_LEAKS.filter(({ re }) => re.test(rendered)).map(({ what }) => ({
    level: "error" as const, code: "INTERNAL_LEAK", messageAr: `الوثيقة النهائية تحتوي ${what}.`,
  }));
}

export function coverSheetAr(matter: Matter, documentName: string, report: VerificationReport, review: ReviewRecord | undefined): string {
  const state = review?.state ?? "draft";
  const lines = [
    `# ورقة غلاف داخلية — ${matter.title}`,
    "",
    `- الوثيقة: ${documentName}`,
    `- تاريخ تطبيق النصوص: ${report.asOf}`,
    `- نتيجة التحقق من الاستشهادات: ${report.verdict} (موثّق ${report.counts.verified} من ${report.counts.cited}، إخفاقات ${report.counts.failed})`,
    `- مواضع «غير موثّق» المتبقية: ${report.counts.unverifiedMarkers}`,
    `- حالة المراجعة: ${state}${review?.reviewer ? ` — ${review.reviewer.name} (${review.reviewer.licenseNo})` : ""}`,
    `- درجة السرية: ${matter.confidentiality}`,
    "",
    "## تنبيهات التحقق",
    ...(report.warnings.length > 0 ? report.warnings.map((w) => `- ${w.messageAr}`) : ["- لا توجد."]),
    "",
    "## تنبيه",
    DISCLAIMER_AR,
  ];
  return lines.join("\n");
}
