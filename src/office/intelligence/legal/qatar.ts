import { createSourceAnchor } from "../citations.js";
import type { ArtifactRef, SourceAnchor } from "../contracts.js";

export interface LegalSource {
  id: string;
  title: string;
  citation: string;
  sourceUrl: string;
  issuer: string;
  text: string;
  effectiveFrom: string;
  effectiveTo?: string;
  retrievedAt: string;
  official: boolean;
}

export interface MatterTimelineEvent {
  date: string;
  title: string;
  source: SourceAnchor;
}

export interface EvidenceItem {
  claim: string;
  evidenceSourceIds: string[];
  status: "supported" | "missing-evidence";
}

export const QATAR_LEGAL_REVIEW_CHECKLIST = [
  "الوقائع ومصادر إثباتها",
  "الاختصاص والإجراءات والمواعيد التي تحتاج تحقق المحامي",
  "النصوص ذات الصلة ونسخها السارية",
  "التحليل والتفسيرات المضادة",
  "الأدلة الناقصة والتعارضات",
  "التوصية وافتراضاتها وحدودها",
] as const;

export function validateLegalSource(source: LegalSource, at = new Date()): void {
  if (!source.official) throw new Error("legal answers require an official source");
  if (!source.citation.trim() || !source.text.trim() || !source.issuer.trim()) throw new Error("legal source citation, issuer and text are required");
  const url = new URL(source.sourceUrl);
  if (url.protocol !== "https:") throw new Error("legal source URL must use HTTPS");
  const from = Date.parse(source.effectiveFrom);
  const to = source.effectiveTo ? Date.parse(source.effectiveTo) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(from) || Number.isNaN(to) || from > at.getTime() || to < at.getTime()) {
    throw new Error("legal source is not effective at the requested date");
  }
  if (!Number.isFinite(Date.parse(source.retrievedAt))) throw new Error("legal source retrieval date is invalid");
}

export function normalizeLegalName(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, "")
    .replace(/[أإآٱ]/gu, "ا").replace(/ى/gu, "ي").replace(/ة/gu, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function findConflictCandidates(
  incomingParties: string[],
  existing: Array<{ matterId: string; client: string; parties: string[] }>,
): Array<{ matterId: string; client: string; matchedParty: string }> {
  const incoming = new Set(incomingParties.map(normalizeLegalName).filter(Boolean));
  const matches = new Map<string, { matterId: string; client: string; matchedParty: string }>();
  for (const matter of existing) {
    for (const party of [matter.client, ...matter.parties]) {
      const normalized = normalizeLegalName(party);
      if (normalized && incoming.has(normalized)) matches.set(`${matter.matterId}|${normalized}`, { matterId: matter.matterId, client: matter.client, matchedParty: party });
    }
  }
  return [...matches.values()];
}

const MONTHS: Record<string, string> = {
  "يناير": "01", "فبراير": "02", "مارس": "03", "أبريل": "04", "ابريل": "04", "مايو": "05", "يونيو": "06",
  "يوليو": "07", "أغسطس": "08", "اغسطس": "08", "سبتمبر": "09", "أكتوبر": "10", "اكتوبر": "10", "نوفمبر": "11", "ديسمبر": "12",
};

function isoDate(day: string, month: string, year: string): string | undefined {
  const candidate = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== candidate ? undefined : candidate;
}

export function extractDatedText(text: string): Array<{ date: string; text: string }> {
  const events: Array<{ date: string; text: string }> = [];
  for (const segment of text.split(/(?<=[.!؟?\n])/u).map((part) => part.trim()).filter(Boolean)) {
    const dates = new Set<string>();
    for (const match of segment.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/gu)) {
      const date = isoDate(match[3]!, match[2]!, match[1]!);
      if (date) dates.add(date);
    }
    for (const match of segment.matchAll(/\b(\d{1,2})[\/]([0-9]{1,2})[\/](\d{4})\b/gu)) {
      const date = isoDate(match[1]!, match[2]!, match[3]!);
      if (date) dates.add(date);
    }
    for (const match of segment.matchAll(/\b(\d{1,2})\s+(\p{L}+)\s+(\d{4})\b/gu)) {
      const month = MONTHS[match[2]!];
      const date = month ? isoDate(match[1]!, month, match[3]!) : undefined;
      if (date) dates.add(date);
    }
    for (const date of dates) events.push({ date, text: segment.slice(0, 1000) });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

export function buildMatterTimeline(artifact: ArtifactRef, blocks: Array<{ anchor: string; text: string }>): MatterTimelineEvent[] {
  return blocks.flatMap((block) => extractDatedText(block.text).map((event) => ({
    date: event.date,
    title: event.text,
    source: createSourceAnchor({ artifact, kind: "block", anchor: block.anchor, text: block.text }),
  }))).sort((a, b) => a.date.localeCompare(b.date));
}

export function buildEvidenceMatrix(
  claims: Array<{ claim: string; evidenceSourceIds: string[] }>,
  availableSourceIds: Set<string>,
): EvidenceItem[] {
  return claims.map((item) => {
    const evidenceSourceIds = [...new Set(item.evidenceSourceIds)].filter((id) => availableSourceIds.has(id));
    return { claim: item.claim.trim(), evidenceSourceIds, status: evidenceSourceIds.length ? ("supported" as const) : ("missing-evidence" as const) };
  }).filter((item) => item.claim);
}

export function compareBilingualClauseNumbers(arabic: string, english: string): { arabic: string[]; english: string[]; missingInArabic: string[]; missingInEnglish: string[] } {
  const numbers = (text: string) => {
    const matches = Array.from(text.matchAll(/(?:^|\n)\s*(?:المادة|البند|Clause|Article)?\s*(\d+(?:\.\d+)*)[.)\-:]/gimu));
    return [...new Set(matches.map((match) => match[1]!))];
  };
  const a = numbers(arabic);
  const b = numbers(english);
  return {
    arabic: a,
    english: b,
    missingInArabic: b.filter((item) => !a.includes(item)),
    missingInEnglish: a.filter((item) => !b.includes(item)),
  };
}
