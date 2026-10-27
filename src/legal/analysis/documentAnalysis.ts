import type { EgressConfig } from "../egress.js";
import type { LegalCorpus } from "../corpusStore.js";
import { DOCUMENT_ANALYSIS_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import type { DocumentAnalysisItem, DocumentAnalysisReport } from "./documentTypes.js";
import { chunkAnalysisBatches, chunkLegalDocument } from "./documentChunks.js";

type AnalysisValue = Omit<DocumentAnalysisReport, "documents" | "timeline" | "contradictions" | "coverage" | "corpusSnapshotId">;

export async function analyzeDocuments(store: MattersStore, corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, matterId: string): Promise<DocumentAnalysisReport> {
  const matter = store.getMatter(matterId);
  if (!matter) throw new Error(`matter ${matterId} not found`);
  const documents = store.evidence.listDocuments(matterId);
  const facts = store.evidence.listFacts(matterId);
  const timeline = store.evidence.listTimeline(matterId);
  const contradictions = store.evidence.listContradictions(matterId);
  const analyze = async (input: unknown, stage: "source_chunk" | "aggregate"): Promise<AnalysisValue> => {
    const result = await callLegalStructured<AnalysisValue>(model.port, {
      contract: "legal-document-analysis",
      model: model.config.localModel,
      schema: DOCUMENT_ANALYSIS_SCHEMA,
      repairAttempts: 2,
      messages: [
        { role: "system", content: stage === "source_chunk"
          ? "Analyze only the supplied source chunk. Fact start/end offsets are relative to chunk.text. Produce a concise factual summary, obligations, risks, missing information and questions. Link conclusions to supplied fact ids only. Do not claim the chunk is the whole bundle or infer absent pages, authenticity, fraud or governing law. Keep the summary under 1500 characters."
          : "Aggregate the supplied partial legal analyses without treating them as new evidence. Preserve supported obligations, risks, missing information and material questions with their original fact ids. Resolve duplication; never turn a review lead into a proven contradiction or invent facts. Keep the executive summary under 1500 characters." },
        { role: "user", content: JSON.stringify(input) },
      ],
    });
    if (!result.ok) throw new Error(`document analysis ${stage} contract failed: ${result.issues.join("; ")}`);
    return result.value;
  };
  const parts: AnalysisValue[] = [];
  for (const document of documents) {
    for (const chunk of chunkLegalDocument(document)) {
      const inChunk = (anchor: { documentId: string; start: number; end: number }) => anchor.documentId === document.id && anchor.start >= chunk.start && anchor.end <= chunk.end;
      parts.push(await analyze({
        matter: { id: matter.id, title: matter.title, kind: matter.kind, asOf: matter.asOf },
        document: { id: document.id, fileName: document.fileName, sha256: document.sha256, language: document.language, warnings: document.warnings },
        chunk,
        facts: facts.flatMap((fact) => {
          const anchor = fact.anchors.find(inChunk);
          return anchor ? [{ id: fact.id, start: anchor.start - chunk.start, end: anchor.end - chunk.start, kind: fact.kind, status: fact.status }] : [];
        }),
        timeline: timeline.filter((event) => event.anchors.some(inChunk)).map((event) => ({ id: event.id, dateLabel: event.dateLabel, sortDate: event.sortDate, description: event.description })),
        contradictions: contradictions.filter((contradiction) => contradiction.anchors.length > 0 && contradiction.anchors.every(inChunk)).map((contradiction) => ({ id: contradiction.id, kind: contradiction.kind, severity: contradiction.severity, title: contradiction.title, details: contradiction.details })),
      }, "source_chunk"));
    }
  }
  let aggregated = parts;
  while (aggregated.length > 1) {
    const next: AnalysisValue[] = [];
    for (const batch of chunkAnalysisBatches(aggregated)) {
      if (JSON.stringify(batch).length > 24_000) throw new Error("document analysis intermediate exceeds the context budget; concise aggregation required");
      next.push(await analyze({ matter: { id: matter.id, title: matter.title, asOf: matter.asOf }, partialAnalyses: batch }, "aggregate"));
    }
    aggregated = next;
  }
  const result = aggregated[0] ?? { summary: "لا توجد مستندات متاحة للتحليل.", obligations: [], risks: [], missingInformation: [], questions: [{ question: "أرفق مستندات المسألة لبدء التحليل.", material: true }] };
  const factIds = new Set(facts.map((fact) => fact.id));
  const valid = (items: DocumentAnalysisItem[]) => items.map((item) => ({ ...item, evidenceFactIds: item.evidenceFactIds.filter((id) => factIds.has(id)) }));
  return {
    summary: result.summary,
    documents, timeline, contradictions,
    obligations: valid(result.obligations), risks: valid(result.risks), missingInformation: valid(result.missingInformation),
    questions: result.questions,
    coverage: corpus.coverage({ asOf: matter.asOf, matterKind: "research" }),
    corpusSnapshotId: corpus.snapshot({ persist: false }).id,
  };
}
