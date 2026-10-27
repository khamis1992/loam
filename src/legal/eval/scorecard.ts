export type LegalEvalProduct = "contract_review" | "defense_memo" | "legal_response" | "document_analysis";
export type LegalEvalSeverity = "critical" | "high" | "normal";

export interface LegalEvalResult {
  id: string;
  product: LegalEvalProduct;
  severity: LegalEvalSeverity;
  citationCorrect?: boolean;
  temporalCorrect?: boolean;
  factAnchorCorrect?: boolean;
  expectedIssues?: string[];
  predictedIssues?: string[];
  claimSupported?: boolean;
  falsePositive?: boolean;
  criticalOmission?: boolean;
  draftingAccepted?: boolean;
  lawyerTimeSeconds?: number;
}

export interface LegalScorecardRow {
  product: LegalEvalProduct;
  severity: LegalEvalSeverity;
  cases: number;
  citationCorrectness?: number;
  temporalAccuracy?: number;
  factAnchorAccuracy?: number;
  issueRecall?: number;
  claimSupport?: number;
  falsePositives: number;
  criticalOmissions: number;
  draftingAcceptance?: number;
  lawyerTimeSeconds?: number;
  pass: boolean;
}

function ratio(values: boolean[]): number | undefined {
  return values.length ? values.filter(Boolean).length / values.length : undefined;
}

export function summarizeLegalScorecard(results: LegalEvalResult[]): LegalScorecardRow[] {
  const groups = new Map<string, LegalEvalResult[]>();
  for (const result of results) {
    const key = `${result.product}:${result.severity}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups].map(([key, cases]): LegalScorecardRow => {
    const [product, severity] = key.split(":") as [LegalEvalProduct, LegalEvalSeverity];
    const recallCases = cases.flatMap((item) => {
      const expected = new Set(item.expectedIssues ?? []);
      if (expected.size === 0) return [];
      const predicted = new Set(item.predictedIssues ?? []);
      return [[...expected].filter((issue) => predicted.has(issue)).length / expected.size];
    });
    const issueRecall = recallCases.length ? recallCases.reduce((total, value) => total + value, 0) / recallCases.length : undefined;
    const criticalOmissions = cases.filter((item) => item.criticalOmission === true).length;
    const criticalFailures = cases.some((item) => item.severity === "critical" && (item.citationCorrect === false || item.temporalCorrect === false || item.factAnchorCorrect === false || item.claimSupported === false));
    return {
      product, severity, cases: cases.length,
      citationCorrectness: ratio(cases.flatMap((item) => item.citationCorrect === undefined ? [] : [item.citationCorrect])),
      temporalAccuracy: ratio(cases.flatMap((item) => item.temporalCorrect === undefined ? [] : [item.temporalCorrect])),
      factAnchorAccuracy: ratio(cases.flatMap((item) => item.factAnchorCorrect === undefined ? [] : [item.factAnchorCorrect])),
      issueRecall,
      claimSupport: ratio(cases.flatMap((item) => item.claimSupported === undefined ? [] : [item.claimSupported])),
      falsePositives: cases.filter((item) => item.falsePositive === true).length,
      criticalOmissions,
      draftingAcceptance: ratio(cases.flatMap((item) => item.draftingAccepted === undefined ? [] : [item.draftingAccepted])),
      lawyerTimeSeconds: cases.reduce((total, item) => total + (item.lawyerTimeSeconds ?? 0), 0),
      pass: criticalOmissions === 0 && !criticalFailures && cases.every((item) => item.criticalOmission !== true),
    };
  });
}
