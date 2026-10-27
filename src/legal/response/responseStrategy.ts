import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { researchIssue } from "../analysis/legalResearch.js";
import type { LegalModelPort } from "../model/types.js";
import type { ResearchRecord } from "../analysis/types.js";
import type { AllegationResponseMatrix } from "./types.js";
import type { FactAssertion } from "../evidence/types.js";

export async function researchResponse(corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, matrix: AllegationResponseMatrix, asOf: string, additionalQueries: string[] = [], factRecords: FactAssertion[] = []): Promise<ResearchRecord[]> {
  const records: ResearchRecord[] = [];
  for (const entry of matrix.entries) {
    records.push(await researchIssue(corpus, model, {
      id: entry.id, title: entry.response, kind: entry.kind === "legal" ? "substantive" : "evidentiary",
      facts: entry.evidenceFactIds, researchQueries: [...entry.researchQueries, ...additionalQueries], material: true,
    }, asOf, factRecords));
  }
  return records;
}
