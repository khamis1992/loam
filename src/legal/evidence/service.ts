import crypto from "node:crypto";
import type { MattersStore } from "../mattersStore.js";
import { detectContradictions } from "./contradictions.js";
import { extractLegalDocument, type ExtractLegalOptions } from "./extract.js";
import { documentFacts } from "./facts.js";
import { documentTimeline } from "./timeline.js";
import type { Contradiction, EvidenceDocument, FactAssertion, TimelineEvent } from "./types.js";

export interface EvidenceAnalysis {
  document: EvidenceDocument;
  facts: FactAssertion[];
  timeline: TimelineEvent[];
  contradictions: Contradiction[];
}

export async function importMatterDocument(store: MattersStore, matterId: string, absPath: string, options: ExtractLegalOptions & { now?: () => Date } = {}): Promise<EvidenceAnalysis> {
  if (!store.getMatter(matterId)) throw new Error(`matter ${matterId} not found`);
  const extracted = await extractLegalDocument(absPath, options);
  const now = options.now?.() ?? new Date();
  const document: EvidenceDocument = {
    ...extracted,
    id: `doc-${crypto.createHash("sha256").update(`${matterId}|${extracted.sha256}`).digest("hex").slice(0, 12)}`,
    matterId,
    importedAt: now.toISOString(),
  };
  const facts = documentFacts(document, options.now);
  const timeline = documentTimeline(document);
  store.evidence.saveDocument(document);
  store.evidence.saveFacts(facts);
  store.evidence.saveTimeline(timeline);
  const documents = store.evidence.listDocuments(matterId);
  const contradictions = detectContradictions(documents);
  store.evidence.saveContradictions(contradictions);
  store.audit.append("user", "evidence.import", matterId, document.id, { sha256: document.sha256, pages: document.pages.length, facts: facts.length });
  return { document, facts, timeline, contradictions };
}
