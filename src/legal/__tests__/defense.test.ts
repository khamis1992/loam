import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { loadFixtureCorpus, fillAvids } from "./helpers.js";
import { importMatterDocument } from "../evidence/service.js";
import { buildDefensePackage } from "../defense/service.js";
import { createDefensePipeline } from "../defense/pipeline.js";
import { draftDefenseMemo } from "../defense/draft.js";
import type { LegalModelPort, LegalModelRequest } from "../model/types.js";

const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
const model: LegalModelPort = async (req: LegalModelRequest & { contract?: string }) => {
  let value: unknown;
  if (req.contract === "defense-case-theory") {
    value = {
      summary: "الدفاع بعدم استحقاق التعويض الاتفاقي",
      pleas: [{ id: "penalty", type: "substantive", title: "التعويض الاتفاقي مبالغ فيه", factIds: ["fact-1"], researchQueries: ["المادة 3 من القانون المدني الاختباري"], priority: 1 }],
      primaryRequests: ["تخفيض التعويض"], alternativeRequests: ["رفض المطالبة"], weaknesses: ["يلزم إثبات المبالغة"],
      unresolvedQuestions: [],
    };
  } else if (req.contract?.startsWith("legal-research:")) {
    value = { claims: [{ id: "penalty", text: "يجوز تخفيض التعويض", support: "supported", authorityAvids: ["QL-3bacb8d64e"], evidenceFactIds: ["fact-1"], exceptions: [], reason: "النص يجيز التخفيض" }] };
  } else if (req.contract === "defense-memo-draft") {
    value = { markdown: `## بيانات الدعوى\nالدائرة المدنية — الدعوى 1/2092\n## الوقائع\nثبت بالمستندات أن التعويض الاتفاقي محل نزاع.\n## الدفاع الموضوعي\n${fillAvids("«يجوز للمتعاقدين أن يحددا مقدماً قيمة التعويض بالنص عليها في العقد، ويجوز للقاضي أن يخفض التعويض الاتفاقي إذا أثبت المدين أن التقدير كان مبالغاً فيه إلى درجة كبيرة.» ⟦cite:{{law/2090/1:body:3@2091-07-01}}⟧")}\n## الطلبات\nأصلياً: تخفيض التعويض.` };
  } else if (req.contract === "legal-adversarial-review") {
    value = { findings: [] };
  } else {
    throw new Error(`unexpected contract ${req.contract}`);
  }
  return { content: JSON.stringify(value), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
};

test("defense package links theory, research, draft and adversarial review", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-defense-"));
  const keys = new StaticKeyProvider(crypto.randomBytes(32));
  const store = new MattersStore(path.join(dir, "matters.db"), keys);
  const matter = store.createMatter({
    title: "دعوى تعويض", kind: "defense_memo", asOf: "2092-01-01",
    court: { name: "المحكمة الابتدائية", caseNumber: "1/2092" },
    parties: [{ role: "client", name: "المدعى عليه", identifiers: [] }],
  }, "user");
  const source = path.join(dir, "evidence.txt");
  fs.writeFileSync(source, "ثبت بالمستندات أن التعويض الاتفاقي محل نزاع.");
  const evidence = await importMatterDocument(store, matter.id, source);
  evidence.facts[0]!.id = "fact-1";
  store.evidence.saveFacts(evidence.facts);
  const corpus = loadFixtureCorpus();
  corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
  corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["defense_memo"] }]);
  const result = await buildDefensePackage(store, corpus, { port: model, config }, matter.id);
  assert.equal(result.theory.pleas[0]?.factIds[0], "fact-1");
  assert.equal(result.verification.verdict, "pass");
  assert.equal(result.quality.ok, true);
  assert.match(result.draft, /الدفاع الموضوعي/);
  store.close();
  corpus.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("defense pipeline pauses for strategy and lawyer approval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-defense-pipeline-"));
  const keys = new StaticKeyProvider(crypto.randomBytes(32));
  const store = new MattersStore(path.join(dir, "matters.db"), keys);
  const matter = store.createMatter({ title: "دعوى", kind: "defense_memo", asOf: "2092-01-01", court: { name: "المحكمة", caseNumber: "1" }, parties: [{ role: "client", name: "المدعى عليه", identifiers: [] }] }, "user");
  const source = path.join(dir, "evidence.txt");
  fs.writeFileSync(source, "ثبت بالمستندات أن التعويض الاتفاقي محل نزاع.");
  const evidence = await importMatterDocument(store, matter.id, source);
  evidence.facts[0]!.id = "fact-1";
  store.evidence.saveFacts(evidence.facts);
  const corpus = loadFixtureCorpus();
  corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
  corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["defense_memo"] }]);
  const pipeline = createDefensePipeline(store, corpus, { port: model, config });
  const run = await pipeline.start({ kind: "defense_memo", matterId: matter.id, state: { matterId: matter.id }, corpusSnapshotId: corpus.snapshot({ persist: false }).id, model: config.localModel, promptVersion: "1" });
  await pipeline.advance(run.id);
  await pipeline.advance(run.id);
  await pipeline.advance(run.id);
  await pipeline.advance(run.id);
  assert.equal((await pipeline.advance(run.id)).status, "waiting");
  assert.equal((await pipeline.resume(run.id, { action: "approve" })).status, "waiting");
  assert.equal((await pipeline.resume(run.id, { action: "approve" })).status, "succeeded");
  let adversarialCalls = 0;
  let draftCalls = 0;
  const correctingModel: typeof model = async (req) => {
    if ((req as typeof req & { contract?: string }).contract === "legal-adversarial-review") {
      adversarialCalls++;
      return { content: JSON.stringify({ findings: adversarialCalls % 2 === 1 ? [{ severity: "critical", code: "contradiction", message: "تناقض يجب إصلاحه" }] : [] }), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    }
    if ((req as typeof req & { contract?: string }).contract === "defense-memo-draft") draftCalls++;
    return model(req);
  };
  const correctingPipeline = createDefensePipeline(store, corpus, { port: correctingModel, config });
  const revised = await correctingPipeline.start({ kind: "defense_memo", matterId: matter.id, state: { matterId: matter.id }, corpusSnapshotId: corpus.snapshot({ persist: false }).id, model: config.localModel, promptVersion: "1" });
  await correctingPipeline.advance(revised.id); await correctingPipeline.advance(revised.id); await correctingPipeline.advance(revised.id); await correctingPipeline.advance(revised.id); await correctingPipeline.advance(revised.id);
  const afterRevision = await correctingPipeline.resume(revised.id, { action: "revise", theory: { summary: "استراتيجية معدلة", pleas: [{ id: "revised-plea", type: "substantive", title: "دفع معدل", factIds: ["fact-1"], researchQueries: ["المادة 3 من القانون المدني الاختباري"], priority: 1 }], primaryRequests: [], alternativeRequests: [], weaknesses: [], unresolvedQuestions: [] } });
  assert.equal(afterRevision.status, "waiting");
  assert.equal((afterRevision.state as { research: Array<{ issueId: string }> }).research[0]?.issueId, "revised-plea");
  assert.equal((await correctingPipeline.resume(revised.id, { action: "approve" })).status, "succeeded");
  assert.equal(adversarialCalls, 2);
  assert.equal(draftCalls, 2);
  const approved = await correctingPipeline.start({ kind: "defense_memo", matterId: matter.id, state: { matterId: matter.id }, corpusSnapshotId: corpus.snapshot({ persist: false }).id, model: config.localModel, promptVersion: "1" });
  await correctingPipeline.advance(approved.id); await correctingPipeline.advance(approved.id); await correctingPipeline.advance(approved.id); await correctingPipeline.advance(approved.id); await correctingPipeline.advance(approved.id);
  assert.equal((await correctingPipeline.resume(approved.id, { action: "approve" })).status, "waiting");
  assert.equal((await correctingPipeline.resume(approved.id, { action: "approve" })).status, "succeeded");
  assert.equal(adversarialCalls, 4);
  assert.equal(draftCalls, 4);
  const stale = await pipeline.start({ kind: "defense_memo", matterId: matter.id, state: { matterId: matter.id }, corpusSnapshotId: corpus.snapshot({ persist: false }).id, model: config.localModel, promptVersion: "1" });
  await pipeline.advance(stale.id); await pipeline.advance(stale.id); await pipeline.advance(stale.id); await pipeline.advance(stale.id); await pipeline.advance(stale.id);
  await pipeline.resume(stale.id, { action: "approve" });
  const version = corpus.db.prepare("SELECT avid, text_sha256 FROM article_versions LIMIT 1").get() as { avid: string; text_sha256: string };
  corpus.db.prepare("UPDATE article_versions SET text_sha256=? WHERE avid=?").run("0".repeat(64), version.avid);
  await assert.rejects(pipeline.resume(stale.id, { action: "approve" }), (error: unknown) => {
    const failed = error as { status: string; error?: string };
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /corpus changed during lawyer review/);
    return true;
  });
  store.close();
  corpus.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("defense draft retries a mismatched quote once and then verifies the exact source", async () => {
  const store = new MattersStore(":memory:", new StaticKeyProvider(crypto.randomBytes(32)));
  const corpus = loadFixtureCorpus();
  try {
    const matter = store.createMatter({ title: "دعوى", kind: "defense_memo", asOf: "2092-01-01" }, "user");
    corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
    corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["defense_memo"] }]);
    let attempts = 0;
    const retryModel: LegalModelPort = async (req) => {
      if ((req as LegalModelRequest & { contract?: string }).contract === "defense-memo-draft" && ++attempts === 1) {
        return { content: JSON.stringify({ markdown: "## بيانات الدعوى\nالدائرة\n## الوقائع\nواقعة.\n## الدفاع الموضوعي\n«نص غير مطابق للمصدر» ⟦cite:QL-3bacb8d64e⟧\n## الطلبات\nتخفيض التعويض." }), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
      }
      return model(req);
    };
    const result = await draftDefenseMemo(corpus, { port: retryModel, config }, {
      matter,
      theory: { summary: "دفاع", pleas: [{ id: "penalty", type: "substantive", title: "المبالغة", factIds: [], researchQueries: [], priority: 1 }], primaryRequests: [], alternativeRequests: [], weaknesses: [], unresolvedQuestions: [] },
      research: [{ issueId: "penalty", asOf: "2092-01-01", queries: [], consultedAvids: ["QL-3bacb8d64e"], claims: [] }],
      facts: [],
    });
    assert.equal(attempts, 2);
    assert.equal(result.verification.verdict, "pass");
  } finally {
    store.close();
    corpus.close();
  }
});
