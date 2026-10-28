import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";
import { loadFixtureCorpus } from "./helpers.js";
import { importMatterDocument } from "../evidence/service.js";
import { analyzeDocuments } from "../analysis/documentAnalysis.js";
import { chunkLegalDocument } from "../analysis/documentChunks.js";
import { createDocumentPipeline } from "../analysis/documentPipeline.js";
import type { LegalModelPort, LegalModelRequest } from "../model/types.js";

const config = { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" };
const model: LegalModelPort = async (req: LegalModelRequest & { contract?: string }) => {
  const value = req.contract === "legal-document-analysis" ? {
    summary: "يوجد اختلاف في قيمة المبلغ",
    obligations: [{ id: "o1", title: "السداد", details: "السداد مستحق", severity: "high", evidenceFactIds: ["fact-1"] }],
    risks: [{ id: "r1", title: "تعارض المبلغ", details: "المبلغان مختلفان", severity: "high", evidenceFactIds: ["fact-1"] }],
    missingInformation: [{ id: "m1", title: "ملحق مفقود", details: "يلزم الملحق", severity: "medium", evidenceFactIds: [] }],
    questions: [{ question: "أي مبلغ معتمد؟", material: true }],
  } : { findings: [] };
  return { content: JSON.stringify(value), model: req.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
};

test("document analysis links findings to facts and completes approval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-doc-analysis-"));
  const keys = new StaticKeyProvider(crypto.randomBytes(32));
  const store = new MattersStore(path.join(dir, "matters.db"), keys);
  const matter = store.createMatter({ title: "حزمة", kind: "research", asOf: "2092-01-01" }, "user");
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  fs.writeFileSync(a, "المبلغ 1000 ريال بتاريخ 2024/01/15.");
  fs.writeFileSync(b, "المبلغ 2000 ريال في ملحق لاحق.");
  const first = await importMatterDocument(store, matter.id, a);
  first.facts[0]!.id = "fact-1";
  store.evidence.saveFacts(first.facts);
  await importMatterDocument(store, matter.id, b);
  const corpus = loadFixtureCorpus();
  corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt','2092-01-01')").run();
  corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["research"] }]);
  const report = await analyzeDocuments(store, corpus, { port: model, config }, matter.id);
  assert.equal(report.obligations[0]?.evidenceFactIds[0], "fact-1");
  assert.equal(report.contradictions.length, 1);
  const pipeline = createDocumentPipeline(store, corpus, { port: model, config });
  const run = await pipeline.start({ kind: "document_analysis", matterId: matter.id, state: { matterId: matter.id }, corpusSnapshotId: corpus.snapshot({ persist: false }).id, model: config.localModel, promptVersion: "1" });
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

test("document chunks cover every character without losing page boundaries", () => {
  const pages = [1, 2, 3].map((page) => ({ page, text: `صفحة ${page}\n${"وقائع اصطناعية متكررة.\n".repeat(700)}`, warnings: [] }));
  const text = pages.map((page) => page.text).join("\n\n");
  const chunks = chunkLegalDocument({ id: "large", matterId: "m", fileName: "large.txt", mime: "text/plain", sha256: "a".repeat(64), language: "ar", importedAt: "2092-01-01", text, pages, warnings: [] }, 1000);
  assert.ok(chunks.length > 3);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1000 && chunk.pages.length > 0));
  assert.equal(chunks.at(-1)?.text, text.slice(chunks.at(-1)?.start));
});

test("large document analysis uses bounded source chunks and preserves the original", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-large-analysis-"));
  const store = new MattersStore(path.join(dir, "matters.db"), new StaticKeyProvider(crypto.randomBytes(32)));
  const corpus = loadFixtureCorpus();
  try {
    const matter = store.createMatter({ title: "ملف كبير", kind: "research", asOf: "2092-01-01" }, "user");
    const large = Array.from({ length: 400 }, (_, index) => `الفقرة ${index}: وقائع اصطناعية لاختبار حدود السياق دون حذف المحتوى.`).join("\n") + "\nالمبلغ النهائي 9000 ريال في الفقرة الأخيرة.";
    const source = path.join(dir, "large.txt");
    fs.writeFileSync(source, large);
    await importMatterDocument(store, matter.id, source);
    const requests: string[] = [];
    const boundedModel: LegalModelPort = async (req) => {
      const prompt = req.messages.at(-2)?.content ?? "";
      requests.push(prompt);
      return model(req);
    };
    const report = await analyzeDocuments(store, corpus, { port: boundedModel, config }, matter.id);
    assert.ok(requests.length >= 3);
    assert.ok(requests.every((prompt) => prompt.length < 40_000), JSON.stringify(requests.map((prompt) => prompt.length)));
    assert.ok(requests.some((prompt) => prompt.includes("المبلغ النهائي 9000")));
    assert.equal(report.documents[0]?.text, large);
  } finally {
    store.close();
    corpus.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
