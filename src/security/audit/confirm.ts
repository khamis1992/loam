/**
 * Confirmation. Dynamic proof is unavailable in this build, so a dynamic claim
 * without a proof artifact, or a finding whose production viability is false or
 * unknown, is downgraded to needs_validation. Severity is bounded by impact.
 */
import { cvss31 } from "./cvss.js";
import { DYNAMIC_BLOCKER } from "./sandbox.js";
import { scoreRank } from "./types.js";
import type { Confirmed, NeedsValidation, Score } from "./types.js";

export interface ConfirmOptions {
  severityModel: "impact" | "cvss";
  /** When true, a missing production_viable counts as "unknown" and downgrades. */
  viabilityRequired: boolean;
  cvssVector?: string;
}

const minScore = (a: Score, b: Score): Score => (scoreRank(a) <= scoreRank(b) ? a : b);

function downgrade(c: Confirmed, blocker: string): NeedsValidation {
  return {
    verdict: "needs_validation", fingerprint: c.fingerprint, title: c.title, description: c.description,
    claimed_root_cause: c.root_cause, trace: c.trace, evidence: c.evidence, blockers: [blocker],
    validation_plan: { local: `Re-verify by hand: ${blocker}` },
    evidence_vector: c.evidence_vector, evidence_assurance: c.evidence_assurance,
  };
}

export function finalizeConfirmed(c: Confirmed, opts: ConfirmOptions): Confirmed | NeedsValidation {
  const dynClaim = c.evidence_vector.some((e) => e.source === "dyn" && e.state === "confirmed");
  if (dynClaim && !c.proof) return downgrade(c, `dynamic claim without a proof artifact (${DYNAMIC_BLOCKER})`);
  const viable = c.production_viable ?? (opts.viabilityRequired ? "unknown" : true);
  if (viable !== true) return downgrade(c, `production viability is ${String(viable)}`);

  let overall = minScore(c.severity.overall_severity, c.severity.impact.score);
  let cvss = c.cvss;
  if (opts.severityModel === "cvss" && opts.cvssVector) {
    const scored = cvss31(opts.cvssVector);
    if (scored) { cvss = scored; overall = minScore(scored.severity, c.severity.impact.score); }
  }
  return { ...c, cvss, severity: { ...c.severity, overall_severity: overall } };
}
