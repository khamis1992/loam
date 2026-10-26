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
import { buildLegalResponse } from "../response/service.js";
import { createResponsePipeline } from "../response/pipeline.js";
import type { LegalModelPort, LegalModelRequest } from "../model/types.js";

const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
const model: LegalModelPort = async (req: LegalModelRequest & { contract?: string }) => {
  let value: unknown;
  if (req.contract === "legal-response-allegations") {
    value = {
      entries: [{ id: "a1", allegation: "استحقاق التعويض كاملاً", kind: "legal", disposition: "explain", evidenceFactIds: ["fact-1"], researchQueries: ["المادة 3 من القانون المدني الاختباري"], response: "التعويض قابل للتخفيض", attachments: [], needsClientDecision: false }],
      unresolvedQuestions: [],
    };
  } else if (req.contract?.startsWith("legal-research:")) {
    value = { claims: [{ id: "a1", text: "يجوز تخفيض التعويض", support: "supported", authorityAvids: ["QL-3bacb8d64e"], evidenceFactIds: ["fact-1"], exceptions: [], reason: "النص يجيز التخفيض" }] };
  } else if (req.contract === "legal-response-draft") {
    value = { markdown: `## بيانات الدعوى\nالدائرة المدنية — الدعوى 1/2092\n## الوقائع\nوردت مطالبة بالتعويض كاملاً.\n## الدفاع الموضوعي\n${fillAvids("«يجوز للمتعاقدين أن يحددا مقدماً قيمة التعويض بالنص عليها في العقد، ويجوز للقاضي أن يخفض التعويض الاتفاقي إذا أثبت المدين أن التقدير كان مبالغاً فيه إلى درجة كبيرة.» ⟦cite:{{law/2090/1:body:3@2091-07-01}}⟧")}\n## الطلبات\nأصلياً: تخفيض التعويض.` };
  } else if (req.contract === "legal-adversarial-review") {
    value = { findings: [] };
  } else {
    throw new Error(`unexpected ${req.contract}`);
  }
  return { content: JSON.stringify(value), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
};

test("legal response covers allegations and approval pipeline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-response-"));
  const keys = new StaticKeyProvider(crypto.randomBytes(32));
  const store = new MattersStore(path.join(dir, "matters.db"), keys);
  const matter = store.createMatter({ title: "رد على مذكرة", kind: "defense_memo", asOf: "2092-01-01", court: { name: "المحكمة", caseNumber: "1" }, parties: [{ role: "client", name: "المدعى عليه", identifiers: [] }] }, "user");
  const source = path.join(dir, "evidence.txt");
  fs.writeFileSync(source, "وردت مطالبة بالتعويض كاملاً.");
  const evidence = await importMatterDocument(store, matter.id, source);
  evidence.facts[0]!.id = "fact-1";
  store.evidence.saveFacts(evidence.facts);
  const corpus = loadFixtureCorpus();
  corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
  corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["defense_memo"] }]);
  const result = await buildLegalResponse(store, corpus, { port: model, config }, { matterId: matter.id, sourceText: "استحقاق التعويض كاملاً" });
  assert.equal(result.matrix.entries[0]?.disposition, "explain");
  assert.equal(result.quality.ok, true);
  assert.match(result.draft, /الدفاع الموضوعي/);
  const pipeline = createResponsePipeline(store, corpus, { port: model, config });
  const run = await pipeline.start({ kind: "legal_response", matterId: matter.id, state: { matterId: matter.id, sourceText: "استحقاق التعويض كاملاً" }, corpusSnapshotId: corpus.snapshot({ persist: false }).id, model: config.localModel, promptVersion: "1" });
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
