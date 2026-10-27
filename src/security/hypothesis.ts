export interface SecurityHypothesis {
  id: string;
  target: string;
  claim: string;
  sensitivity: number;
  provability: number;
  requestCost: number;
}

export interface HypothesisValidation {
  status: "confirmed" | "refuted" | "inconclusive";
  observation: string;
  evidenceIds: string[];
}

export interface HypothesisResult extends SecurityHypothesis {
  status: "confirmed" | "refuted" | "inconclusive" | "unverified";
  observation: string;
  evidenceIds: string[];
}

export function rankHypotheses(items: SecurityHypothesis[]): SecurityHypothesis[] {
  return [...items].sort((a, b) => {
    const score = (item: SecurityHypothesis): number => item.sensitivity * 3 + item.provability * 2 - item.requestCost / 10;
    return score(b) - score(a) || a.id.localeCompare(b.id);
  });
}

export async function runHypothesisCampaign(items: SecurityHypothesis[], validator: (item: SecurityHypothesis) => Promise<HypothesisValidation>, options: { maxRequests: number }): Promise<HypothesisResult[]> {
  if (options.maxRequests < 1) throw new Error("a positive request budget is required");
  const results: HypothesisResult[] = [];
  let used = 0;
  for (const item of rankHypotheses(items)) {
    if (item.requestCost < 1 || item.sensitivity < 0 || item.provability < 0) throw new Error("invalid hypothesis parameters");
    if (used + item.requestCost > options.maxRequests) {
      results.push({ ...item, status: "unverified", observation: "request budget exhausted", evidenceIds: [] });
      continue;
    }
    used += item.requestCost;
    try {
      const result = await validator(item);
      if (!result.observation.trim() || (result.status === "confirmed" && result.evidenceIds.length === 0)) results.push({ ...item, status: "unverified", observation: "validator did not provide conclusive evidence", evidenceIds: [] });
      else results.push({ ...item, ...result });
    } catch (error) {
      results.push({ ...item, status: "unverified", observation: (error instanceof Error ? error.message : String(error)).slice(0, 300), evidenceIds: [] });
    }
  }
  return results;
}
