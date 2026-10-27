import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeLegalScorecard, type LegalEvalResult } from "../eval/scorecard.js";

const base: LegalEvalResult = { id: "normal", product: "defense_memo", severity: "normal", citationCorrect: true, temporalCorrect: true, factAnchorCorrect: true, claimSupported: true, expectedIssues: ["a", "b"], predictedIssues: ["a"], draftingAccepted: true, lawyerTimeSeconds: 12 };

test("scorecards report each product and severity without hiding critical errors in an average", () => {
  const rows = summarizeLegalScorecard([
    base,
    { ...base, id: "fatal", severity: "critical", citationCorrect: false },
    { ...base, id: "omission", severity: "high", criticalOmission: true },
    { ...base, id: "contract", product: "contract_review" },
  ]);
  const normal = rows.find((row) => row.severity === "normal")!;
  assert.equal(normal.citationCorrectness, 1);
  assert.equal(normal.issueRecall, 0.5);
  assert.equal(normal.draftingAcceptance, 1);
  assert.equal(normal.lawyerTimeSeconds, 12);
  assert.equal(rows.find((row) => row.severity === "critical")?.pass, false);
  assert.equal(rows.find((row) => row.severity === "high")?.pass, false);
  assert.equal(rows.length, 4);
});

test("issue recall is averaged per case rather than pooled across cases", () => {
  const rows = summarizeLegalScorecard([
    { ...base, id: "one", expectedIssues: ["a"], predictedIssues: ["a"] },
    { ...base, id: "two", expectedIssues: ["b"], predictedIssues: [] },
  ]);
  assert.equal(rows[0]?.issueRecall, 0.5);
});
