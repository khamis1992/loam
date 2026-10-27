import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./legal-mock-server.js";
import { segmentContract } from "../legal/contract/clauses.js";
import { LegalRunManager } from "../legal/pipeline/manager.js";
import type { CaseTheory } from "../legal/defense/types.js";
import type { AllegationResponseMatrix } from "../legal/response/types.js";
import type { ResearchRecord } from "../legal/analysis/types.js";

if (process.env.LOAM_LEGAL_LIVE !== "1") throw new Error("Set LOAM_LEGAL_LIVE=1 to run the real local-model smoke test; fixtures are synthetic, not Qatari law.");

const srv = await startMockServer();
const modelCalls: Array<{ contract: string; durationMs: number; promptTokens: number; completionTokens: number }> = [];
const port = srv.ctx.model.port;
srv.ctx.model.port = async (req) => {
  const started = Date.now();
  const response = await port(req);
  modelCalls.push({ contract: /Contract: (.+?)\. Schema:/.exec(req.messages.at(-1)?.content ?? "")?.[1] ?? "unknown", durationMs: Date.now() - started, promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens });
  return response;
};
const results: Array<{ product: string; ok: boolean; durationMs: number; details: unknown; performance: { modelCalls: typeof modelCalls; memoryRssBytes: number } }> = [];
const selected = new Set((process.env.LOAM_LEGAL_LIVE_PRODUCT ?? "document_analysis,contract_review,defense_memo,legal_response").split(","));
async function measure(product: string, run: () => Promise<unknown>): Promise<void> {
  if (!selected.has(product)) return;
  const started = Date.now();
  const callStarted = modelCalls.length;
  const performance = () => ({ modelCalls: modelCalls.slice(callStarted), memoryRssBytes: process.memoryUsage().rss });
  try {
    const value = await run();
    results.push({ product, ok: true, durationMs: Date.now() - started, details: value, performance: performance() });
  } catch (error) {
    results.push({ product, ok: false, durationMs: Date.now() - started, details: error instanceof Error ? error.message : String(error), performance: performance() });
  }
  console.error(JSON.stringify(results.at(-1)));
}

try {
  const verifiedAt = new Date().toISOString();
  srv.ctx.corpus.db.prepare("UPDATE legislations SET source_json=json_set(source_json,'$.verifiedAt',?)").run(verifiedAt);
  srv.ctx.corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "قانون اختباري اصطناعي", requiredFor: ["contract_review", "research", "defense_memo"] }]);
  const defense = srv.ctx.matters.createMatter({ title: "LIVE-SMOKE: طلب تخفيض التعويض الاتفاقي لأنه مبالغ فيه", kind: "defense_memo", asOf: "2092-01-01" }, "user");
  const contractMatter = srv.ctx.matters.createMatter({ title: "LIVE-SMOKE contract synthetic", kind: "contract_review", asOf: "2092-01-01" }, "user");
  const evidencePath = path.join(os.tmpdir(), `legal-live-smoke-${process.pid}.txt`);
  const coreEvidence = "البند الخامس من العقد المؤرخ 2091/01/01: عند الإخلال يلتزم المدين بتعويض اتفاقي قدره 100000 ريال قطري.\nثبت بكشف الحساب والمستندات أن الضرر الفعلي الناتج عن الإخلال هو 1000 ريال قطري.\nأُعذر المدين بتاريخ 2091/11/01 وثبت الإخلال بتاريخ 2091/12/01.";
  const evidenceText = process.env.LOAM_LEGAL_LIVE_LARGE === "1" ? `${Array.from({ length: 400 }, (_, index) => `الفقرة ${index + 1}: مستند اصطناعي لاختبار التحليل متعدد الدفعات دون فقدان المواضع.`).join("\n")}\n${coreEvidence}` : coreEvidence;
  fs.writeFileSync(evidencePath, evidenceText, "utf8");
  await srv.ctx.importDocument(defense.id, evidencePath);
  fs.rmSync(evidencePath, { force: true });

  await measure("document_analysis", async () => {
    const report = await srv.ctx.analyzeDocuments(defense.id);
    if (!report.summary.trim()) throw new Error("empty summary");
    return { summaryChars: report.summary.length, documentChars: report.documents.reduce((total, document) => total + document.text.length, 0), obligations: report.obligations.length, risks: report.risks.length, snapshot: report.corpusSnapshotId };
  });
  await measure("contract_review", async () => {
    const text = "البند 1\nالثمن 1000 ريال.\nالبند 2\nلا يجوز إنهاء العقد في أي وقت.";
    const contract = srv.ctx.matters.addContract(contractMatter.id, { fileName: "synthetic.txt", mime: "text/plain", text, language: "ar" }, "user");
    srv.ctx.matters.saveClauses(contract.id, segmentContract(contract.id, text));
    const { reviewContractDetailed } = await import("../legal/contract/review.js");
    const { DEFAULT_QATAR_PLAYBOOK } = await import("../legal/contract/playbook.js");
    const report = await reviewContractDetailed(srv.ctx.matters.clauses(contract.id), DEFAULT_QATAR_PLAYBOOK, { corpus: srv.ctx.corpus, asOf: "2092-01-01", contractType: "any", fullText: text, clientPosition: "buyer", riskTolerance: "balanced" }, { port: srv.ctx.model.port, config: srv.ctx.egress });
    return { deterministicFindings: report.findings.length, negotiation: report.negotiation.length, snapshot: report.corpusSnapshotId };
  });
  await measure("defense_memo", async () => {
    const manager = new LegalRunManager(srv.ctx.matters, srv.ctx.corpus, { port: srv.ctx.model.port, config: srv.ctx.egress });
    const run = await manager.start("defense_memo", defense.id, { matterId: defense.id });
    const waiting = await manager.idle(run.id);
    if (waiting?.status !== "waiting") throw new Error(JSON.stringify(waiting));
    const state = waiting.state as { theory: CaseTheory; research: ResearchRecord[] };
    const supported = new Set(state.research.filter((record) => record.claims.length > 0 && record.claims.every((claim) => claim.support === "supported")).map((record) => record.issueId));
    const pleas = state.theory.pleas.filter((plea) => supported.has(plea.id));
    if (pleas.length === 0) throw new Error(JSON.stringify({ reason: "no fully supported defense issue", research: state.research }));
    await manager.resume(run.id, { action: "revise", theory: { ...state.theory, pleas, primaryRequests: ["تخفيض التعويض الاتفاقي بالقدر الذي يثبت معه المدين المبالغة الكبيرة في تقديره."], alternativeRequests: [] } });
    const reviewed = await manager.idle(run.id);
    if (reviewed?.status !== "waiting") throw new Error(JSON.stringify(reviewed));
    await manager.resume(run.id, { action: "approve" });
    const final = await manager.idle(run.id);
    const result = final?.state as { theory: CaseTheory; research: ResearchRecord[]; verification: { verdict: string }; quality: { ok: boolean; issues: unknown[] } };
    if (final?.status !== "succeeded" || !result.quality.ok) throw new Error(JSON.stringify(final));
    return { pleas: result.theory.pleas.length, verdict: result.verification.verdict, revisedFrom: state.theory.pleas.length, supportedClaims: result.research.flatMap((record) => record.claims).filter((claim) => claim.support === "supported").length };
  });
  await measure("legal_response", async () => {
    const manager = new LegalRunManager(srv.ctx.matters, srv.ctx.corpus, { port: srv.ctx.model.port, config: srv.ctx.egress });
    const run = await manager.start("legal_response", defense.id, { matterId: defense.id, sourceText: "استحقاق التعويض الاتفاقي كاملاً." });
    const waiting = await manager.idle(run.id);
    if (waiting?.status !== "waiting") throw new Error(JSON.stringify(waiting));
    const state = waiting.state as { matrix: AllegationResponseMatrix; research: ResearchRecord[] };
    const supported = new Set(state.research.filter((record) => record.claims.length > 0 && record.claims.every((claim) => claim.support === "supported")).map((record) => record.issueId));
    const entries = state.matrix.entries.filter((entry) => supported.has(entry.id));
    if (entries.length === 0) throw new Error(JSON.stringify({ reason: "no fully supported response issue", research: state.research }));
    await manager.resume(run.id, { action: "revise", matrix: { ...state.matrix, entries } });
    const reviewed = await manager.idle(run.id);
    if (reviewed?.status !== "waiting") throw new Error(JSON.stringify(reviewed));
    await manager.resume(run.id, { action: "approve" });
    const final = await manager.idle(run.id);
    const result = final?.state as { matrix: AllegationResponseMatrix; research: ResearchRecord[]; verification: { verdict: string }; quality: { ok: boolean; issues: unknown[] } };
    if (final?.status !== "succeeded" || !result.quality.ok) throw new Error(JSON.stringify(final));
    return { allegations: result.matrix.entries.length, verdict: result.verification.verdict, revisedFrom: state.matrix.entries.length, supportedClaims: result.research.flatMap((record) => record.claims).filter((claim) => claim.support === "supported").length };
  });
} finally {
  await srv.close();
}

const output = { model: "qwen3.6:35b-a3b", syntheticFixtures: true, officialCorpus: false, results };
console.log(JSON.stringify(output, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
