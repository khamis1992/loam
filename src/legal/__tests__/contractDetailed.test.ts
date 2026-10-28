import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFixtureCorpus } from "./helpers.js";
import { segmentContract } from "../contract/clauses.js";
import { DEFAULT_QATAR_PLAYBOOK } from "../contract/playbook.js";
import { reviewContractDetailed } from "../contract/review.js";
import { compareBilingualClauses } from "../contract/bilingual.js";
import type { LegalModelPort } from "../model/types.js";

const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
const model: LegalModelPort = async (req) => ({
  content: JSON.stringify({ findings: [{ id: "model-risk", ruleId: "MODEL-1", severity: "high", titleAr: "خطر سياقي", explanationAr: "تحليل سياقي", suggestionAr: "اقتراح" }] }),
  model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

test("detailed review combines position, model findings and negotiation", async () => {
  const corpus = loadFixtureCorpus();
  const clauses = segmentContract("ct-1", "البند 1\nالثمن 1000 ريال\nالبند 2\nلا يكون الطرف الثاني مسؤولاً عن أي أضرار");
  const report = await reviewContractDetailed(clauses, DEFAULT_QATAR_PLAYBOOK, {
    corpus, asOf: "2092-01-01", contractType: "services", fullText: clauses.map((clause) => clause.text).join("\n"),
    clientPosition: "buyer", riskTolerance: "conservative",
  }, { port: model, config });
  assert.equal(report.clientPosition, "buyer");
  assert.ok(report.findings.some((finding) => finding.titleAr === "خطر سياقي"));
  assert.ok(report.negotiation.some((item) => item.priority === "must_change"));
  assert.equal(report.corpusSnapshotId, corpus.snapshot({ persist: false }).id);
  corpus.close();
});

test("bilingual comparison catches numeric mismatches", () => {
  const arabic = segmentContract("ar", "البند 1\nالثمن 1000 ريال");
  const english = segmentContract("en", "Clause 1\nPrice 2000 QR");
  const findings = compareBilingualClauses("mt-1", arabic, english);
  assert.equal(findings[0]?.kind, "bilingual");
  assert.equal(findings[0]?.severity, "high");
});
