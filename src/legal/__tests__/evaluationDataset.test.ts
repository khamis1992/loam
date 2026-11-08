import assert from "node:assert/strict";
import { test } from "node:test";
import { compareLegalEvaluations, evaluateLegalDataset, validateLegalEvalDataset, type LegalEvalDataset } from "../evaluation/dataset.js";
import type { LegalEvalProduct, LegalEvalResult } from "../eval/scorecard.js";

const products: LegalEvalProduct[] = ["contract_review", "defense_memo", "legal_response", "document_analysis"];
const results: LegalEvalResult[] = products.map((product) => ({
  id: product, product, severity: "critical", citationCorrect: true, temporalCorrect: true,
  factAnchorCorrect: true, claimSupported: true, criticalOmission: false,
  adversarialCriticalFalsePositive: false, lawyerTimeSeconds: 30,
}));

function dataset(): LegalEvalDataset {
  return {
    format: "loam-legal-eval/1", datasetId: "professional-test", source: "professional_anonymized",
    frozen: true, createdAt: "2026-11-08T00:00:00.000Z", reviewers: ["lawyer-1", "lawyer-2"],
    adjudicatedBy: "lawyer-3",
    context: { model: "qwen3.6:35b-a3b", corpusSnapshotId: "CS-test", playbookVersion: "pb-test", promptVersion: "prompt-test" },
    results: structuredClone(results),
  };
}

test("professional evaluation requires frozen, adjudicated, anonymized coverage of all four products", () => {
  const value = dataset();
  assert.deepEqual(validateLegalEvalDataset(value), []);
  assert.equal(evaluateLegalDataset(value).pass, true);
  const missing = dataset();
  missing.results = missing.results.filter((item) => item.product !== "legal_response");
  assert.ok(validateLegalEvalDataset(missing).some((error) => error.includes("legal_response")));
  const unfrozen = dataset() as unknown as Record<string, unknown>;
  unfrozen.frozen = false;
  assert.ok(validateLegalEvalDataset(unfrozen).some((error) => error.includes("frozen")));
});

test("critical omissions, adversarial critical false positives and wrong evidence fail closed", () => {
  for (const patch of [{ criticalOmission: true }, { adversarialCriticalFalsePositive: true }, { citationCorrect: false }, { temporalCorrect: false }, { factAnchorCorrect: false }]) {
    const value = dataset();
    value.results[0] = { ...value.results[0]!, ...patch };
    assert.equal(evaluateLegalDataset(value).pass, false);
  }
});

test("baseline comparisons reject silent model changes, changed cases and quality regressions", () => {
  const baseline = evaluateLegalDataset(dataset());
  assert.deepEqual(compareLegalEvaluations(baseline, baseline), { pass: true, regressions: [] });
  const changedModel = dataset();
  changedModel.context.model = "another-model";
  assert.ok(compareLegalEvaluations(evaluateLegalDataset(changedModel), baseline).regressions.some((error) => error.includes("model")));
  const regressed = dataset();
  regressed.results[0]!.citationCorrect = false;
  assert.equal(compareLegalEvaluations(evaluateLegalDataset(regressed), baseline).pass, false);
  const changedCases = dataset();
  changedCases.results.reverse();
  assert.ok(compareLegalEvaluations(evaluateLegalDataset(changedCases), baseline).regressions.some((error) => error.includes("cases")));
});
