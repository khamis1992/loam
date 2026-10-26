import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { researchIssue } from "../analysis/legalResearch.js";
import type { LegalModelPort } from "../model/types.js";
import type { ResearchRecord } from "../analysis/types.js";
import type { AllegationResponseMatrix } from "./types.js";

export async function researchResponse(corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, matrix: AllegationResponseMatrix, asOf: string): Promise<ResearchRecord[]> {
  const records: ResearchRecord[] = [];
  for (const entry of matrix.entries) {
    records.push(await researchIssue(corpus, model, {
      id: entry.id, title: entry.allegation, kind: entry.kind === "legal" ? "substantive" : "evidentiary",
      facts: entry.evidenceFactIds, researchQueries: entry.researchQueries, material: true,
    }, asOf));
  }
  return records;
}
