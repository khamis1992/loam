import type { ReviewFinding } from "../types.js";
import type { NegotiationItem, RiskTolerance } from "./types.js";

export function negotiationPlan(findings: ReviewFinding[], tolerance: RiskTolerance): NegotiationItem[] {
  return findings.map((finding) => {
    const severe = finding.severity === "high" || finding.severity === "medium";
    const priority: NegotiationItem["priority"] = finding.severity === "high" ? "must_change" : severe && tolerance !== "aggressive" ? "negotiate" : finding.severity === "low" ? "acceptable" : "escalate";
    return {
      findingId: finding.id, priority,
      rationale: finding.explanationAr,
      ...(finding.suggestionAr ? { fallback: finding.suggestionAr } : {}),
    };
  });
}
