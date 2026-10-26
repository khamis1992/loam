import type { EvidenceAnchor } from "../evidence/types.js";

export interface LegalIssue {
  id: string;
  title: string;
  kind: "procedural" | "substantive" | "evidentiary" | "contractual";
  facts: string[];
  researchQueries: string[];
  material: boolean;
}

export type SupportStatus = "supported" | "contradicted" | "insufficient" | "not_researched";

export interface ClaimSupport {
  id: string;
  text: string;
  support: SupportStatus;
  authorityAvids: string[];
  evidenceFactIds: string[];
  exceptions: string[];
  reason: string;
}

export interface ResearchRecord {
  issueId: string;
  asOf: string;
  queries: string[];
  consultedAvids: string[];
  claims: ClaimSupport[];
}

export interface UnresolvedQuestion {
  id: string;
  question: string;
  reason: string;
  material: boolean;
}

export interface AdversarialFinding {
  severity: "info" | "warning" | "high" | "critical";
  code: "unsupported_fact" | "unsupported_claim" | "missing_exception" | "unintended_admission" | "contradiction" | "unenforceable_request" | "stronger_defense" | "coverage_gap";
  message: string;
  span?: string;
}

export interface QualityIssue {
  code: string;
  message: string;
  anchors?: EvidenceAnchor[];
}
