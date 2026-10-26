import type { CoverageReport } from "../corpus/coverage.js";
import type { AdversarialFinding, ClaimSupport, QualityIssue } from "./types.js";

export function qualityGate(input: { claims: ClaimSupport[]; findings?: AdversarialFinding[]; coverage: CoverageReport }): { ok: boolean; issues: QualityIssue[] } {
  const issues: QualityIssue[] = [];
  if (input.coverage.status !== "complete") issues.push({ code: "coverage_incomplete", message: `Corpus coverage is ${input.coverage.status}` });
  for (const claim of input.claims) {
    if (claim.support !== "supported") issues.push({ code: `claim_${claim.support}`, message: `${claim.id}: ${claim.reason}` });
    if (claim.support === "supported" && claim.authorityAvids.length === 0 && claim.evidenceFactIds.length === 0) {
      issues.push({ code: "claim_without_support", message: `${claim.id}: no authority or evidence linked` });
    }
  }
  for (const finding of input.findings ?? []) {
    if (finding.severity === "critical") issues.push({ code: finding.code, message: finding.message });
  }
  return { ok: issues.length === 0, issues };
}
