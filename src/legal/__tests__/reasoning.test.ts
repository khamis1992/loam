import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { makeAvid } from "../corpusStore.js";
import { loadFixtureCorpus } from "./helpers.js";
import { researchIssue } from "../analysis/legalResearch.js";
import { qualityGate } from "../analysis/claimSupport.js";
import { adversarialReview } from "../analysis/adversarial.js";
import { callLegalStructured } from "../model/structured.js";
import { LegalPipeline } from "../pipeline/engine.js";
import type { LegalModelPort } from "../model/types.js";

const model = (value: unknown): LegalModelPort => async (req) => ({ content: JSON.stringify(value), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } });
const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };

test("structured output validates the contract and rejects unknown properties", async () => {
  const result = await callLegalStructured<{ value: string }>(model({ value: "ok", extra: true }), {
    contract: "test", model: config.localModel, messages: [],
    schema: { type: "object", required: ["value"], properties: { value: { type: "string" } }, additionalProperties: false },
  });
  assert.equal(result.ok, false);
});

test("research links claims only to retrieved authorities and gates unsupported analysis", async () => {
  const corpus = loadFixtureCorpus();
  const avid = makeAvid("law/2090/1:body:3", "2091-07-01");
  const issue = { id: "penalty", title: "تعديل التعويض الاتفاقي", kind: "substantive" as const, facts: ["fact-1"], researchQueries: ["المادة 3 من القانون المدني الاختباري"], material: true };
  const record = await researchIssue(corpus, { port: model({ claims: [{ id: "c1", text: "يجوز تخفيض التعويض", support: "supported", authorityAvids: [avid], evidenceFactIds: ["fact-1"], exceptions: [], reason: "النص يجيز التخفيض" }] }), config }, issue, "2092-01-01");
  assert.deepEqual(record.claims[0]?.authorityAvids, [avid]);
  assert.equal(qualityGate({ claims: record.claims, coverage: { status: "complete", matterKind: "research", asOf: "2092-01-01", entries: 1, issues: [], checkedAt: "2092-01-01" } }).ok, true);
  const invalid = await researchIssue(corpus, { port: model({ claims: [{ id: "c1", text: "ادعاء", support: "supported", authorityAvids: ["QL-ffffffffff"], evidenceFactIds: [], exceptions: [], reason: "غير مسترجع" }] }), config }, issue, "2092-01-01");
  assert.equal(invalid.claims[0]?.support, "insufficient");
  const noAuthority = await researchIssue(corpus, { port: model({ claims: [] }), config }, { ...issue, researchQueries: ["zzzzqqqqxxxx"] }, "2092-01-01");
  assert.equal(noAuthority.claims[0]?.support, "not_researched");
  corpus.close();
});

test("critical adversarial findings block the quality gate", async () => {
  const findings = await adversarialReview({ port: model({ findings: [{ severity: "critical", code: "unsupported_fact", message: "واقعة بلا دليل" }] }), config }, { draft: "مسودة", facts: {}, authorities: {}, coverage: {} });
  const gate = qualityGate({ claims: [], findings, coverage: { status: "complete", matterKind: "research", asOf: "2092-01-01", entries: 1, issues: [], checkedAt: "2092-01-01" } });
  assert.equal(gate.ok, false);
  assert.equal(gate.issues[0]?.code, "unsupported_fact");
});

test("pipeline persists checkpoints and resumes waiting and failed runs explicitly", async () => {
  const store = new MattersStore(":memory:", new StaticKeyProvider(crypto.randomBytes(32)));
  const matter = store.createMatter({ title: "اختبار", kind: "research" }, "user");
  const pipeline = new LegalPipeline(store.pipeline, {
    intake: async () => ({ state: { value: 1 } }),
    review: async () => ({ state: { value: 2 }, waiting: true }),
    done: async () => ({ state: { value: 3 }, succeeded: true }),
  }, ["intake", "review", "done"]);
  const run = await pipeline.start({ kind: "document_analysis", matterId: matter.id, state: {}, corpusSnapshotId: "CS-test", model: config.localModel, promptVersion: "1" });
  assert.equal((await pipeline.advance(run.id)).stage, "review");
  assert.equal((await pipeline.advance(run.id)).status, "waiting");
  const completed = await pipeline.resume(run.id, "answer");
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.completedStages.length, 3);
  const raw = JSON.stringify(store.db.prepare("SELECT payload_enc FROM pipeline_runs").all());
  assert.equal(raw.includes("answer"), false);
  const failing = new LegalPipeline(store.pipeline, { bad: async () => { throw new Error("stage failed"); }, done: async () => ({ state: {}, succeeded: true }) }, ["bad", "done"]);
  const failed = await failing.start({ kind: "document_analysis", matterId: matter.id, state: {}, corpusSnapshotId: "CS-test", model: config.localModel, promptVersion: "1" });
  assert.equal((await failing.advance(failed.id).catch((error: unknown) => error) as { status?: string }).status, "failed");
  assert.equal(store.pipeline.get(failed.id)?.status, "failed");
  const resumed = await failing.resume(failed.id).catch((error: unknown) => error);
  assert.equal((resumed as { status?: string }).status, "failed");
  store.close();
});
