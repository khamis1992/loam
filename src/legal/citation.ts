/**
 * Formal citation rendering. A verified token becomes the citation a Qatari
 * lawyer writes by hand, derived ONLY from stored metadata (never from model
 * output), so the rendered reference cannot drift from the verified text.
 */
import type { LegalCorpus } from "./corpusStore.js";
import { renderLabelAr } from "./normalize.js";
import type { Legislation, LegislationType, ResolvedArticle } from "./types.js";

const TYPE_AR: Record<LegislationType, string> = {
  constitution: "الدستور",
  law: "القانون",
  "decree-law": "المرسوم بقانون",
  decree: "المرسوم",
  "emiri-decision": "القرار الأميري",
  "emiri-order": "الأمر الأميري",
  "cabinet-decision": "قرار مجلس الوزراء",
  "prime-minister-decision": "قرار رئيس مجلس الوزراء",
  "ministerial-decision": "القرار الوزاري",
  decision: "القرار",
  "public-prosecutor-decision": "قرار النائب العام",
  other: "التشريع",
};

const TYPE_EN: Record<LegislationType, string> = {
  constitution: "Constitution", law: "Law", "decree-law": "Decree-Law", decree: "Decree",
  "emiri-decision": "Emiri Decision", "emiri-order": "Emiri Order", "cabinet-decision": "Cabinet Decision",
  "prime-minister-decision": "Prime Minister Decision", "ministerial-decision": "Ministerial Decision",
  decision: "Decision", "public-prosecutor-decision": "Public Prosecutor Decision", other: "Legislation",
};

/** "القانون رقم (22) لسنة 2004" (constitution: its title). */
export function formalRefAr(leg: Legislation): string {
  if (leg.type === "constitution") return leg.titleAr;
  return `${TYPE_AR[leg.type]} رقم (${leg.number}) لسنة ${leg.year}`;
}

export function formalRefEn(leg: Legislation): string {
  if (leg.type === "constitution") return leg.titleEn ?? `Constitution of ${leg.year}`;
  return `${TYPE_EN[leg.type]} No. ${leg.number} of ${leg.year}`;
}

/** The short name lawyers use, when the pack gave one ("القانون المدني"). */
export function shortNameAr(leg: Legislation): string | undefined {
  return leg.aliases.find((a) => a !== leg.titleAr);
}

export function renderCitationAr(r: ResolvedArticle, corpus: LegalCorpus, historical = false): string {
  const label = renderLabelAr(r.article.label);
  const leg = r.legislation;
  let out: string;
  if (leg.type === "constitution") out = `المادة (${label}) من ${leg.titleAr}`;
  else if (r.article.part === "issuance") out = `المادة (${label}) من ${formalRefAr(leg)}`;
  else {
    const short = shortNameAr(leg);
    out = short ? `المادة (${label}) من ${short} الصادر ب${formalRefAr(leg)}` : `المادة (${label}) من ${formalRefAr(leg)}`;
  }
  if (r.version.origin === "amendment" && r.version.introducedBy) {
    const by = corpus.getLegislation(r.version.introducedBy);
    if (by) out += `، المستبدلة بموجب ${formalRefAr(by)}`;
  }
  if (historical && r.version.effectiveTo) out += ` (بنصها السابق الساري حتى ${r.version.effectiveTo})`;
  return out;
}

export function renderCitationEn(r: ResolvedArticle): string {
  const label = r.article.label.replace(/bis(\d+)?$/, (_m, n: string | undefined) => (n ? ` bis (${n})` : " bis"));
  return `Article ${label} of ${formalRefEn(r.legislation)}`;
}
