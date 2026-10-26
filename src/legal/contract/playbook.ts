/**
 * Playbook review: deterministic rules over classified clauses, each finding
 * tied either to lawyer-PINNED authorities (resolved and verified at the matter
 * date) or to retrieval SUGGESTIONS a lawyer must confirm. The default Qatari
 * playbook deliberately ships with NO article numbers: numbers are pinned by a
 * lawyer after checking the official text, never typed in by this codebase.
 */
import crypto from "node:crypto";
import type { LegalCorpus } from "../corpusStore.js";
import { foldWithMap } from "../references.js";
import { searchLaw } from "../retrieval.js";
import { CITABLE_PROVENANCE, type Clause, type ClauseCategory, type FindingSeverity, type ReviewFinding, type SourceProvenance } from "../types.js";

export type ContractType = "any" | "employment" | "commercial_agency" | "lease" | "services" | "sale" | "nda";

export type RuleCheck =
  | { type: "require_category"; category: ClauseCategory }
  | { type: "require_pattern"; category: ClauseCategory; pattern: string }
  | { type: "forbid_pattern"; category: ClauseCategory | "any"; pattern: string }
  | { type: "flag_category"; category: ClauseCategory }
  | { type: "max_percent"; category: ClauseCategory; max: number }
  | { type: "require_if_text"; trigger: string; category: ClauseCategory };

export interface PlaybookRule {
  id: string;
  titleAr: string;
  severity: FindingSeverity;
  appliesTo: ContractType[];
  check: RuleCheck;
  explanationAr: string;
  suggestionAr?: string;
  /** Queries run against the corpus to SUGGEST authorities. */
  authorityQueries: string[];
  /** Authorities pinned by a lawyer after checking the official text. */
  pinnedAuthorities: Array<{ legKey: string; part?: "issuance" | "body"; label: string }>;
}

export interface Playbook { id: string; nameAr: string; version: string; rules: PlaybookRule[] }

export const DEFAULT_QATAR_PLAYBOOK: Playbook = {
  id: "qa-default",
  nameAr: "دليل المراجعة الافتراضي — دولة قطر",
  version: "1.0.0",
  rules: [
    { id: "QA-GL-0", titleAr: "لا يوجد بند للقانون الواجب التطبيق", severity: "high", appliesTo: ["any"],
      check: { type: "require_category", category: "governing_law" },
      explanationAr: "غياب بند القانون الواجب التطبيق يفتح باب النزاع حول القانون الذي يحكم العقد.",
      suggestionAr: "يُضاف بند: «يخضع هذا العقد ويُفسَّر وفقاً لقوانين دولة قطر».", authorityQueries: ["القانون الواجب التطبيق على العقود"], pinnedAuthorities: [] },
    { id: "QA-GL-1", titleAr: "القانون الواجب التطبيق ليس القانون القطري", severity: "medium", appliesTo: ["any"],
      check: { type: "require_pattern", category: "governing_law", pattern: "قطر|qatar" },
      explanationAr: "اختيار قانون أجنبي لعقد يُنفَّذ في قطر يحتاج مبرراً، وقد تحكم قواعد آمرة قطرية بعض المسائل رغم الاختيار.",
      suggestionAr: "اعتماد القانون القطري أو توثيق مبرر الاختيار الأجنبي.", authorityQueries: ["تنازع القوانين من حيث المكان العقود"], pinnedAuthorities: [] },
    { id: "QA-DR-0", titleAr: "لا توجد آلية لتسوية النزاعات", severity: "medium", appliesTo: ["any"],
      check: { type: "require_category", category: "dispute_resolution" },
      explanationAr: "غياب بند الاختصاص أو التحكيم يترك الاختصاص للقواعد العامة.", suggestionAr: "تحديد المحكمة المختصة في قطر أو التحكيم وقواعده ومقره.",
      authorityQueries: ["الاختصاص المحلي للمحاكم", "اتفاق التحكيم"], pinnedAuthorities: [] },
    { id: "QA-LIAB-1", titleAr: "لا يوجد سقف للمسؤولية", severity: "medium", appliesTo: ["any"],
      check: { type: "require_pattern", category: "liability", pattern: "حد اقصي|الحد الاقصي|لا تتجاوز|لا يتجاوز|سقف|cap|shall not exceed|aggregate liability" },
      explanationAr: "بند المسؤولية بلا سقف يعرّض الطرف لمسؤولية غير محدودة.", suggestionAr: "تحديد سقف للمسؤولية مع استثناء الغش والخطأ الجسيم.",
      authorityQueries: ["تعديل أحكام المسؤولية بالاتفاق"], pinnedAuthorities: [] },
    { id: "QA-LIAB-2", titleAr: "إعفاء مطلق من المسؤولية", severity: "high", appliesTo: ["any"],
      check: { type: "forbid_pattern", category: "any", pattern: "اعفاء\\s*(?:كامل|تام|مطلق)|(?:لا يكون|يكون غير)\\s+(?:\\S+\\s+){0,3}?مسوول[اه]?\\s+عن\\s+(?:اي|كافه|جميع)|غير مسوول[اه]?\\s+عن\\s+(?:اي|كافه|جميع)|shall not be liable for any|no liability whatsoever" },
      explanationAr: "الإعفاء المطلق قد يتعارض مع حظر الإعفاء من المسؤولية عن الغش أو الخطأ الجسيم.", suggestionAr: "قصر الإعفاء على الخطأ اليسير واستثناء الغش والخطأ الجسيم صراحة.",
      authorityQueries: ["الإعفاء من المسؤولية عن الغش أو الخطأ الجسيم"], pinnedAuthorities: [] },
    { id: "QA-PEN-1", titleAr: "شرط جزائي مرتفع", severity: "medium", appliesTo: ["any"],
      check: { type: "max_percent", category: "penalty", max: 20 },
      explanationAr: "نسبة التعويض الاتفاقي المرتفعة قابلة للتخفيض قضائياً إذا ثبت أنها مبالغ فيها.", suggestionAr: "خفض النسبة أو ربطها بالضرر الفعلي مع سقف.",
      authorityQueries: ["الشرط الجزائي تخفيض التعويض الاتفاقي"], pinnedAuthorities: [] },
    { id: "QA-PEN-0", titleAr: "يتضمن العقد شرطاً جزائياً", severity: "info", appliesTo: ["any"],
      check: { type: "flag_category", category: "penalty" },
      explanationAr: "راجع تناسب الشرط الجزائي مع الضرر المتوقع.", authorityQueries: ["الشرط الجزائي"], pinnedAuthorities: [] },
    { id: "QA-NC-1", titleAr: "شرط عدم منافسة في عقد عمل", severity: "medium", appliesTo: ["employment"],
      check: { type: "flag_category", category: "non_compete" },
      explanationAr: "شرط عدم المنافسة في عقود العمل مقيّد بأحكام قانون العمل وتعديلاته السارية؛ تحقق من المدة والنطاق والموافقات المطلوبة وفق النص الساري في تاريخ المسألة.",
      suggestionAr: "قصر الشرط زمنياً وجغرافياً ونوعياً بما يتفق مع النص الساري.", authorityQueries: ["شرط عدم المنافسة قانون العمل"], pinnedAuthorities: [] },
    { id: "QA-FM-0", titleAr: "لا يوجد بند للقوة القاهرة", severity: "low", appliesTo: ["any"],
      check: { type: "require_category", category: "force_majeure" },
      explanationAr: "غياب البند يترك المسألة للقواعد العامة في استحالة التنفيذ.", suggestionAr: "إضافة تعريف للقوة القاهرة وآثارها والإخطار بها.",
      authorityQueries: ["استحالة التنفيذ القوة القاهرة انفساخ العقد"], pinnedAuthorities: [] },
    { id: "QA-CONF-0", titleAr: "لا يوجد بند للسرية", severity: "low", appliesTo: ["services", "employment", "nda", "commercial_agency"],
      check: { type: "require_category", category: "confidentiality" },
      explanationAr: "غياب بند السرية يضعف حماية المعلومات المتبادلة.", authorityQueries: [], pinnedAuthorities: [] },
    { id: "QA-DP-0", titleAr: "بيانات شخصية بلا بند لحمايتها", severity: "medium", appliesTo: ["any"],
      check: { type: "require_if_text", trigger: "بيانات شخصيه|البيانات الشخصيه|personal data|رقم الهويه|qid", category: "data_protection" },
      explanationAr: "معالجة بيانات شخصية دون بند يحدد الغرض والضمانات قد تخالف تشريعات حماية خصوصية البيانات.",
      suggestionAr: "إضافة بند لمعالجة البيانات الشخصية وحمايتها.", authorityQueries: ["حماية خصوصية البيانات الشخصية"], pinnedAuthorities: [] },
    { id: "QA-LANG-0", titleAr: "لم تُحدد اللغة المرجّحة", severity: "low", appliesTo: ["any"],
      check: { type: "require_category", category: "language" },
      explanationAr: "في العقود ثنائية اللغة يلزم تحديد النص المعتمد عند الاختلاف.", suggestionAr: "«يُحرَّر هذا العقد باللغتين العربية والإنجليزية، ويُعتمد النص العربي عند الاختلاف».",
      authorityQueries: ["حماية اللغة العربية العقود"], pinnedAuthorities: [] },
  ],
};

function folded(text: string): string { return foldWithMap(text).folded; }

function percentsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of folded(text).matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|٪|في\s*الميه|بالميه|percent)/gu)) out.push(Number((m[1] ?? "0").replace(",", ".")));
  return out;
}

export interface ReviewContext {
  corpus: LegalCorpus;
  asOf: string;
  contractType: ContractType;
  fullText: string;
}

function ruleApplies(rule: PlaybookRule, type: ContractType): boolean {
  return rule.appliesTo.includes("any") || rule.appliesTo.includes(type);
}

async function authoritiesFor(rule: PlaybookRule, ctx: ReviewContext): Promise<{ pinned: string[]; suggested: string[]; unresolved: string[] }> {
  const pinned: string[] = [];
  const unresolved: string[] = [];
  for (const p of rule.pinnedAuthorities) {
    const v = ctx.corpus.versionAt(`${p.legKey}:${p.part ?? "body"}:${p.label}`, ctx.asOf);
    const prov = v ? (ctx.corpus.provenanceOf(v.avid) as SourceProvenance | undefined) : undefined;
    if (v && prov && CITABLE_PROVENANCE.has(prov)) pinned.push(v.avid);
    else unresolved.push(`${p.legKey}#${p.label}`);
  }
  const suggested: string[] = [];
  for (const q of rule.authorityQueries) {
    const res = await searchLaw(ctx.corpus, q, { asOf: ctx.asOf, k: 2 });
    const usable = res.hits.filter((h) => h.citable && h.bm25 > 0);
    if (usable.length === 0) unresolved.push(q);
    for (const h of usable) if (!suggested.includes(h.avid) && !pinned.includes(h.avid)) suggested.push(h.avid);
  }
  return { pinned, suggested, unresolved };
}

export async function reviewContract(clauses: Clause[], playbook: Playbook, ctx: ReviewContext): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];
  const byCat = (cat: ClauseCategory): Clause[] => clauses.filter((c) => c.categories.includes(cat));
  const make = async (rule: PlaybookRule, clause: Clause | null, extra = ""): Promise<void> => {
    const a = await authoritiesFor(rule, ctx);
    findings.push({
      id: `fd-${crypto.createHash("sha256").update(`${rule.id}|${clause?.id ?? "-"}|${extra}`).digest("hex").slice(0, 10)}`,
      ruleId: rule.id,
      clauseId: clause?.id ?? null,
      severity: rule.severity,
      titleAr: rule.titleAr,
      explanationAr: extra ? `${rule.explanationAr} ${extra}` : rule.explanationAr,
      ...(rule.suggestionAr ? { suggestionAr: rule.suggestionAr } : {}),
      authorities: a.pinned,
      suggestedAuthorities: a.suggested,
      unresolvedAuthorityQueries: a.unresolved,
    });
  };
  for (const rule of playbook.rules) {
    if (!ruleApplies(rule, ctx.contractType)) continue;
    const c = rule.check;
    switch (c.type) {
      case "require_category":
        if (byCat(c.category).length === 0) await make(rule, null);
        break;
      case "require_pattern": {
        const re = new RegExp(c.pattern, "iu");
        for (const cl of byCat(c.category)) if (!re.test(folded(cl.text))) await make(rule, cl);
        break;
      }
      case "forbid_pattern": {
        const re = new RegExp(c.pattern, "iu");
        const scope = c.category === "any" ? clauses : byCat(c.category);
        for (const cl of scope) if (re.test(folded(cl.text))) await make(rule, cl);
        break;
      }
      case "flag_category":
        for (const cl of byCat(c.category)) await make(rule, cl);
        break;
      case "max_percent":
        for (const cl of byCat(c.category)) {
          const over = percentsIn(cl.text).filter((p) => p > c.max);
          if (over.length > 0) await make(rule, cl, `(النسبة المذكورة: ${over.join("، ")}%، والحد الإرشادي ${c.max}%)`);
        }
        break;
      case "require_if_text":
        if (new RegExp(c.trigger, "iu").test(folded(ctx.fullText)) && byCat(c.category).length === 0) await make(rule, null);
        break;
    }
  }
  const order: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.ruleId.localeCompare(b.ruleId));
}

/** Validate a user/lawyer-supplied playbook (JSON from the UI). */
export function validatePlaybook(p: unknown): string[] {
  const errors: string[] = [];
  if (!p || typeof p !== "object") return ["playbook must be an object"];
  const pb = p as Partial<Playbook>;
  if (!pb.id || !pb.nameAr || !Array.isArray(pb.rules)) errors.push("id, nameAr and rules[] are required");
  const ids = new Set<string>();
  for (const [i, r] of (pb.rules ?? []).entries()) {
    if (!r.id || ids.has(r.id)) errors.push(`rules[${i}].id missing or duplicate`);
    ids.add(r.id);
    if (!["high", "medium", "low", "info"].includes(r.severity)) errors.push(`rules[${i}].severity invalid`);
    const pattern = (r.check as { pattern?: string; trigger?: string } | undefined);
    for (const src of [pattern?.pattern, pattern?.trigger]) {
      if (src === undefined) continue;
      try { new RegExp(src, "iu"); } catch { errors.push(`rules[${i}] has an invalid regular expression`); }
    }
    if (!Array.isArray(r.authorityQueries) || !Array.isArray(r.pinnedAuthorities)) errors.push(`rules[${i}] needs authorityQueries[] and pinnedAuthorities[]`);
  }
  return errors;
}
