import type { VerificationReport } from "../types.js";
import type { AdversarialFinding, ResearchRecord } from "../analysis/types.js";
import type { StructureIssue } from "../memo.js";

export type AllegationDisposition = "admit" | "deny" | "no_knowledge" | "explain" | "procedural";

export interface AllegationResponse {
  id: string;
  allegation: string;
  kind: "factual" | "legal" | "request";
  disposition: AllegationDisposition;
  evidenceFactIds: string[];
  researchQueries: string[];
  response: string;
  attachments: string[];
  needsClientDecision: boolean;
}

export interface AllegationResponseMatrix {
  entries: AllegationResponse[];
  unresolvedQuestions: Array<{ question: string; material: boolean }>;
}

export interface LegalResponsePackage {
  matrix: AllegationResponseMatrix;
  research: ResearchRecord[];
  draft: string;
  verification: VerificationReport;
  structure: StructureIssue[];
  adversarial: AdversarialFinding[];
}
