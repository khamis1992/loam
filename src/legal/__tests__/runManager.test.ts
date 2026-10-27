import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { fillAvids, loadFixtureCorpus } from "./helpers.js";
import { importMatterDocument } from "../evidence/service.js";
import { LegalRunManager } from "../pipeline/manager.js";
import type { LegalModelPort, LegalModelRequest } from "../model/types.js";

const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
const model: LegalModelPort = async (req: LegalModelRequest & { contract?: string }) => {
  let value: unknown;
  if (req.contract === "defense-case-theory") value = { summary: "دفاع اختباري", pleas: [{ id: "penalty", type: "substantive", title: "التعويض مبالغ فيه", factIds: [], researchQueries: ["المادة 3 من القانون المدني الاختباري"], priority: 1 }], primaryRequests: ["تخفيض التعويض"], alternativeRequests: [], weaknesses: [], unresolvedQuestions: [] };
  else if (req.contract?.startsWith("legal-research:")) value = { claims: [{ id: "penalty", text: "يجوز التخفيض", support: "supported", authorityAvids: ["QL-3bacb8d64e"], evidenceFactIds: [], exceptions: [], reason: "النص يجيز" }] };
  else if (req.contract === "defense-memo-draft") value = { markdown: `## بيانات الدعوى\nالدائرة المدنية\n## الوقائع\nواقعة.\n## الدفاع الموضوعي\n${fillAvids("«يجوز للمتعاقدين أن يحددا مقدماً قيمة التعويض بالنص عليها في العقد، ويجوز للقاضي أن يخفض التعويض الاتفاقي إذا أثبت المدين أن التقدير كان مبالغاً فيه إلى درجة كبيرة.» ⟦cite:{{law/2090/1:body:3@2091-07-01}}⟧")}\n## الطلبات\nتخفيض التعويض.` };
  else if (req.contract === "legal-adversarial-review") value = { findings: [] };
  else throw new Error(`unexpected ${req.contract}`);
  return { content: JSON.stringify(value), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
};

test("run manager pauses, cancels, resumes explicitly and survives manager recreation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-run-manager-"));
  const store = new MattersStore(path.join(dir, "matters.db"), new StaticKeyProvider(crypto.randomBytes(32)));
  const corpus = loadFixtureCorpus();
  try {
    const matter = store.createMatter({ title: "دعوى", kind: "defense_memo", asOf: "2092-01-01" }, "user");
    const source = path.join(dir, "evidence.txt");
    fs.writeFileSync(source, "التعويض الاتفاقي محل نزاع.");
    await importMatterDocument(store, matter.id, source);
    corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
    corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون الاختباري", requiredFor: ["defense_memo"] }]);
    const manager = new LegalRunManager(store, corpus, { port: model, config });
    const run = await manager.start("defense_memo", matter.id, { matterId: matter.id });
    assert.equal((await manager.idle(run.id))?.status, "waiting");
    assert.equal((await manager.idle(run.id))?.stage, "draft");
    await manager.resume(run.id, { action: "approve" });
    assert.equal((await manager.idle(run.id))?.stage, "export");
    const restarted = new LegalRunManager(store, corpus, { port: model, config });
    await restarted.resume(run.id, { action: "approve" });
    assert.equal((await restarted.idle(run.id))?.status, "succeeded");

    let allowTheory = false;
    let theoryStarted: (() => void) | undefined;
    const blockingModel: LegalModelPort = (req) => {
      if ((req as LegalModelRequest & { contract?: string }).contract === "defense-case-theory" && !allowTheory) return new Promise((_resolve, reject) => {
        theoryStarted?.();
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return model(req);
    };
    const blocking = new LegalRunManager(store, corpus, { port: blockingModel, config });
    const cancelledRun = await blocking.start("defense_memo", matter.id, { matterId: matter.id });
    await new Promise<void>((resolve) => { theoryStarted = resolve; });
    await blocking.cancel(cancelledRun.id);
    assert.equal((await blocking.idle(cancelledRun.id))?.status, "cancelled");
    allowTheory = true;
    await blocking.resume(cancelledRun.id);
    assert.equal((await blocking.idle(cancelledRun.id))?.stage, "draft");
  } finally {
    store.close(); corpus.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("document analysis and contract review persist results and require review before export", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-other-runs-"));
  const store = new MattersStore(path.join(dir, "matters.db"), new StaticKeyProvider(crypto.randomBytes(32)));
  const corpus = loadFixtureCorpus();
  const localModel: LegalModelPort = async (req) => {
    const contract = (req as LegalModelRequest & { contract?: string }).contract;
    const value = contract === "legal-document-analysis"
      ? { summary: "تحليل اختباري", obligations: [], risks: [], missingInformation: [], questions: [] }
      : { findings: [] };
    return { content: JSON.stringify(value), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  };
  try {
    const matter = store.createMatter({ title: "عقد", kind: "contract_review", asOf: "2092-01-01" }, "user");
    corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
    corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون الاختباري", requiredFor: ["contract_review", "research"] }]);
    const manager = new LegalRunManager(store, corpus, { port: localModel, config });
    const analysis = await manager.start("document_analysis", matter.id, { matterId: matter.id });
    assert.equal((await manager.idle(analysis.id))?.status, "waiting");
    await manager.resume(analysis.id, { action: "approve" });
    const analysisResult = (await manager.idle(analysis.id))?.state as { report: { summary: string } };
    assert.equal(analysisResult.report.summary, "تحليل اختباري");

    const contract = store.addContract(matter.id, { fileName: "contract.txt", mime: "text/plain", text: "البند 1\nالثمن 1000 ريال", language: "ar" }, "user");
    store.saveClauses(contract.id, (await import("../contract/clauses.js")).segmentContract(contract.id, contract.text));
    const review = await manager.start("contract_review", matter.id, { matterId: matter.id, contractId: contract.id, contractType: "any", clientPosition: "buyer", riskTolerance: "balanced" });
    assert.equal((await manager.idle(review.id))?.status, "waiting");
    await manager.resume(review.id, { action: "approve" });
    const reviewResult = (await manager.idle(review.id))?.state as { report: { findings: unknown[] } };
    assert.ok(Array.isArray(reviewResult.report.findings));
    assert.equal((await manager.idle(review.id))?.status, "succeeded");
  } finally {
    store.close(); corpus.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
