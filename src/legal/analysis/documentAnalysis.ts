import type { EgressConfig } from "../egress.js";
import type { LegalCorpus } from "../corpusStore.js";
import { DOCUMENT_ANALYSIS_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import type { DocumentAnalysisItem, DocumentAnalysisReport } from "./documentTypes.js";

export async function analyzeDocuments(store: MattersStore, corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, matterId: string): Promise<DocumentAnalysisReport> {
  const matter = store.getMatter(matterId);
  if (!matter) throw new Error(`matter ${matterId} not found`);
  const documents = store.evidence.listDocuments(matterId);
  const facts = store.evidence.listFacts(matterId);
  const timeline = store.evidence.listTimeline(matterId);
  const contradictions = store.evidence.listContradictions(matterId);
  const result = await callLegalStructured<Omit<DocumentAnalysisReport, "documents" | "timeline" | "contradictions" | "coverage" | "corpusSnapshotId">>(model.port, {
    contract: "legal-document-analysis",
    model: model.config.localModel,
    schema: DOCUMENT_ANALYSIS_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "Analyze the legal document bundle. Produce a factual executive summary, obligations, risks, missing information and questions. Link conclusions to supplied fact ids only. Distinguish proven contradictions from review leads. Do not infer missing pages, authenticity, fraud or governing law from memory." },
      { role: "user", content: JSON.stringify({ matter, documents, facts, timeline, contradictions }) },
    ],
  });
  if (!result.ok) throw new Error(`document analysis contract failed: ${result.issues.join("; ")}`);
  const factIds = new Set(facts.map((fact) => fact.id));
  const valid = (items: DocumentAnalysisItem[]) => items.map((item) => ({ ...item, evidenceFactIds: item.evidenceFactIds.filter((id) => factIds.has(id)) }));
  return {
    summary: result.value.summary,
    documents, timeline, contradictions,
    obligations: valid(result.value.obligations), risks: valid(result.value.risks), missingInformation: valid(result.value.missingInformation),
    questions: result.value.questions,
    coverage: corpus.coverage({ asOf: matter.asOf, matterKind: "research" }),
    corpusSnapshotId: corpus.snapshot({ persist: false }).id,
  };
}
