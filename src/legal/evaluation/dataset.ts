import { summarizeLegalScorecard, type LegalEvalProduct, type LegalEvalResult, type LegalScorecardRow } from "../eval/scorecard.js";

export interface LegalEvalContext {
  model: string;
  corpusSnapshotId: string;
  playbookVersion: string;
  promptVersion: string;
}

export interface LegalEvalDataset {
  format: "loam-legal-eval/1";
  datasetId: string;
  source: "professional_anonymized";
  frozen: true;
  createdAt: string;
  reviewers: string[];
  adjudicatedBy: string;
  context: LegalEvalContext;
  results: LegalEvalResult[];
}

export interface LegalEvalOutcome {
  datasetId: string;
  context: LegalEvalContext;
  resultIds: string[];
  rows: LegalScorecardRow[];
  pass: boolean;
}

const PRODUCTS: readonly LegalEvalProduct[] = ["contract_review", "defense_memo", "legal_response", "document_analysis"];
const EVIDENCE_FIELDS = ["citationCorrect", "temporalCorrect", "factAnchorCorrect", "claimSupported"] as const;

export function validateLegalEvalDataset(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["dataset must be an object"];
  const dataset = value as Partial<LegalEvalDataset>;
  const errors: string[] = [];
  if (dataset.format !== "loam-legal-eval/1") errors.push("format must be loam-legal-eval/1");
  if (!dataset.datasetId?.trim()) errors.push("datasetId is required");
  if (dataset.source !== "professional_anonymized") errors.push("source must be professional_anonymized");
  if (dataset.frozen !== true) errors.push("the acceptance dataset must be frozen");
  if (!dataset.createdAt || !Number.isFinite(Date.parse(dataset.createdAt))) errors.push("createdAt must be an ISO timestamp");
  const reviewers = Array.isArray(dataset.reviewers) ? dataset.reviewers.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  if (new Set(reviewers.map((item) => item.trim().toLocaleLowerCase())).size < 2) errors.push("two distinct lawyer reviewer ids are required");
  if (!dataset.adjudicatedBy?.trim()) errors.push("adjudicatedBy is required");
  for (const key of ["model", "corpusSnapshotId", "playbookVersion", "promptVersion"] as const) {
    if (!dataset.context?.[key]?.trim()) errors.push(`context.${key} is required`);
  }
  if (!Array.isArray(dataset.results) || dataset.results.length === 0) {
    errors.push("results must not be empty");
    return errors;
  }
  const ids = new Set<string>();
  for (const [index, result] of dataset.results.entries()) {
    if (!result || typeof result !== "object") { errors.push(`results[${index}] must be an object`); continue; }
    if (!result.id?.trim()) errors.push(`results[${index}].id is required`);
    if (ids.has(result.id)) errors.push(`duplicate result id: ${result.id}`);
    ids.add(result.id);
    if (!PRODUCTS.includes(result.product)) errors.push(`results[${index}].product is invalid`);
    if (!["critical", "high", "normal"].includes(result.severity)) errors.push(`results[${index}].severity is invalid`);
  }
  for (const product of PRODUCTS) {
    if (!dataset.results.some((result) => result.product === product)) errors.push(`missing product: ${product}`);
  }
  return errors;
}

export function evaluateLegalDataset(value: unknown): LegalEvalOutcome {
  const errors = validateLegalEvalDataset(value);
  if (errors.length > 0) throw new Error(`invalid legal evaluation dataset: ${errors.join("; ")}`);
  const dataset = value as LegalEvalDataset;
  const rows = summarizeLegalScorecard(dataset.results);
  const evidenceFailures = dataset.results.filter((item) => EVIDENCE_FIELDS.some((field) => item[field] === false));
  return {
    datasetId: dataset.datasetId, context: dataset.context, resultIds: dataset.results.map((item) => item.id), rows,
    pass: rows.every((row) => row.pass) && evidenceFailures.length === 0,
  };
}

export function compareLegalEvaluations(current: LegalEvalOutcome, baseline: LegalEvalOutcome): { pass: boolean; regressions: string[] } {
  const regressions: string[] = [];
  for (const key of ["model", "corpusSnapshotId", "playbookVersion", "promptVersion"] as const) {
    if (current.context[key] !== baseline.context[key]) regressions.push(`evaluation context differs: ${key}`);
  }
  if (current.resultIds.join("\n") !== baseline.resultIds.join("\n")) regressions.push("frozen evaluation cases or their order differ");
  for (const row of current.rows) {
    const before = baseline.rows.find((item) => item.product === row.product && item.severity === row.severity);
    if (!before) { regressions.push(`missing baseline group: ${row.product}:${row.severity}`); continue; }
    if (before.pass && !row.pass) regressions.push(`acceptance regressed: ${row.product}:${row.severity}`);
    for (const key of ["citationCorrectness", "temporalAccuracy", "factAnchorAccuracy", "issueRecall", "claimSupport"] as const) {
      if (before[key] !== undefined && (row[key] ?? 0) < before[key]!) regressions.push(`${key} regressed: ${row.product}:${row.severity}`);
    }
    if (row.criticalOmissions > before.criticalOmissions) regressions.push(`critical omissions increased: ${row.product}:${row.severity}`);
    if (row.adversarialCriticalFalsePositives > before.adversarialCriticalFalsePositives) regressions.push(`adversarial critical false positives increased: ${row.product}:${row.severity}`);
  }
  return { pass: regressions.length === 0, regressions };
}
