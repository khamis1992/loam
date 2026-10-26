import type { CoverageReport } from "../corpus/coverage.js";
import type { Contradiction, EvidenceDocument, FactAssertion, TimelineEvent } from "../evidence/types.js";

export interface DocumentAnalysisItem {
  id: string;
  title: string;
  details: string;
  severity: "high" | "medium" | "low" | "info";
  evidenceFactIds: string[];
}

export interface DocumentAnalysisReport {
  summary: string;
  documents: EvidenceDocument[];
  timeline: TimelineEvent[];
  contradictions: Contradiction[];
  obligations: DocumentAnalysisItem[];
  risks: DocumentAnalysisItem[];
  missingInformation: DocumentAnalysisItem[];
  questions: Array<{ question: string; material: boolean }>;
  coverage: CoverageReport;
  corpusSnapshotId: string;
}
