import type { VerificationReport } from "../types.js";
import type { AdversarialFinding, ResearchRecord } from "../analysis/types.js";
import type { StructureIssue } from "../memo.js";

export interface DefensePlea {
  id: string;
  type: "procedural" | "substantive" | "evidentiary";
  title: string;
  factIds: string[];
  researchQueries: string[];
  priority: number;
}

export interface CaseTheory {
  summary: string;
  pleas: DefensePlea[];
  primaryRequests: string[];
  alternativeRequests: string[];
  weaknesses: string[];
  unresolvedQuestions: Array<{ question: string; material: boolean }>;
}

export interface DefensePackage {
  theory: CaseTheory;
  research: ResearchRecord[];
  draft: string;
  verification: VerificationReport;
  structure: StructureIssue[];
  adversarial: AdversarialFinding[];
}
