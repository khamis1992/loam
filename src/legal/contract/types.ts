import type { CoverageReport } from "../corpus/coverage.js";
import type { Contradiction } from "../evidence/types.js";
import type { ReviewFinding } from "../types.js";

export type ClientPosition = "buyer" | "seller" | "employer" | "employee" | "landlord" | "tenant" | "contractor" | "client" | "principal" | "agent" | "other";
export type RiskTolerance = "conservative" | "balanced" | "aggressive";

export interface NegotiationItem {
  findingId: string;
  priority: "must_change" | "negotiate" | "acceptable" | "escalate";
  rationale: string;
  fallback?: string;
}

export interface ContractReviewReport {
  clientPosition: ClientPosition;
  riskTolerance: RiskTolerance;
  findings: ReviewFinding[];
  bilingualFindings: Contradiction[];
  negotiation: NegotiationItem[];
  coverage: CoverageReport;
  corpusSnapshotId: string;
}
