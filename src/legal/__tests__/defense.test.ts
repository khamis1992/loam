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
  store.close();
  corpus.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
