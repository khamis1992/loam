export interface ControlObservation {
  matched: boolean;
  observation: string;
  evidenceIds: string[];
}

export interface ValidatedClaim {
  status: "confirmed" | "refuted" | "review" | "inconclusive";
  reason: string;
  evidenceIds: string[];
}

export function validateWithControls(positive: ControlObservation, negative: ControlObservation): ValidatedClaim {
  const evidenceIds = [...new Set([...positive.evidenceIds, ...negative.evidenceIds])];
  if (!positive.observation.trim() || !negative.observation.trim() || evidenceIds.length === 0) return { status: "inconclusive", reason: "positive or negative evidence is missing", evidenceIds };
  if (positive.matched && negative.matched) return { status: "confirmed", reason: "positive and negative controls both demonstrate the claim", evidenceIds };
  if (!positive.matched && !negative.matched) return { status: "refuted", reason: "both controls refute the claim", evidenceIds };
  return { status: "inconclusive", reason: "controls disagree; the result is not conclusive", evidenceIds };
}

export function reviewStaticIndicator(observation: string, evidenceIds: string[]): ValidatedClaim {
  return { status: "review", reason: observation.trim() || "static indicator requires dynamic validation", evidenceIds: [...new Set(evidenceIds)] };
}
