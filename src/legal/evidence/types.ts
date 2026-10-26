export interface ExtractedPage {
  page: number;
  text: string;
  confidence?: number;
  warnings: string[];
}

export interface ExtractedDocument {
  fileName: string;
  mime: string;
  sha256: string;
  language: "ar" | "en" | "mixed";
  text: string;
  pages: ExtractedPage[];
  warnings: string[];
}

export interface EvidenceAnchor {
  documentId: string;
  page?: number;
  paragraph?: number;
  start: number;
  end: number;
  quote: string;
  sha256: string;
}

export interface EvidenceDocument extends ExtractedDocument {
  id: string;
  matterId: string;
  importedAt: string;
}

export type FactKind = "documented" | "client_instruction" | "assumption" | "unresolved";
export type ReviewStatus = "unreviewed" | "confirmed" | "rejected";

export interface FactAssertion {
  id: string;
  matterId: string;
  text: string;
  kind: FactKind;
  status: ReviewStatus;
  anchors: EvidenceAnchor[];
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  matterId: string;
  dateLabel: string;
  sortDate: string;
  description: string;
  anchors: EvidenceAnchor[];
}

export interface Contradiction {
  id: string;
  matterId: string;
  kind: "amount" | "date" | "party" | "text" | "bilingual";
  severity: "info" | "warning" | "high";
  title: string;
  details: string;
  anchors: EvidenceAnchor[];
}
