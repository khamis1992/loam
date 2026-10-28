import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { researchIssue } from "../analysis/legalResearch.js";
import { cachedResearch, mapResearchTasks, researchInputHash } from "../analysis/researchCache.js";
import type { LegalModelPort } from "../model/types.js";
import type { ResearchRecord } from "../analysis/types.js";
import type { AllegationResponseMatrix } from "./types.js";
import type { FactAssertion } from "../evidence/types.js";

export async function researchResponse(corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, matrix: AllegationResponseMatrix, asOf: string, additionalQueries: string[] = [], factRecords: FactAssertion[] = [], previous: ResearchRecord[] = []): Promise<ResearchRecord[]> {
  return mapResearchTasks(matrix.entries, async (entry) => {
    const issue = {
      id: entry.id, title: entry.response, kind: entry.kind === "legal" ? "substantive" as const : "evidentiary" as const,
      facts: entry.evidenceFactIds, researchQueries: [...entry.researchQueries, ...additionalQueries], material: true,
    };
    const inputSha256 = researchInputHash(corpus, issue, asOf, factRecords, model.config.localModel);
    return cachedResearch(previous, issue.id, inputSha256) ?? researchIssue(corpus, model, issue, asOf, factRecords);
  });
}
