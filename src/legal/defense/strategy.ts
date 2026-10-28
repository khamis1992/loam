import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { researchIssue } from "../analysis/legalResearch.js";
import { cachedResearch, mapResearchTasks, researchInputHash } from "../analysis/researchCache.js";
import type { LegalModelPort } from "../model/types.js";
import type { ResearchRecord } from "../analysis/types.js";
import type { CaseTheory } from "./types.js";
import type { FactAssertion } from "../evidence/types.js";

export async function researchDefense(corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, theory: CaseTheory, asOf: string, additionalQueries: string[] = [], factRecords: FactAssertion[] = [], previous: ResearchRecord[] = []): Promise<ResearchRecord[]> {
  return mapResearchTasks(theory.pleas, async (plea) => {
    const issue = {
      id: plea.id,
      title: plea.title,
      kind: plea.type === "procedural" ? "procedural" as const : plea.type === "evidentiary" ? "evidentiary" as const : "substantive" as const,
      facts: plea.factIds,
      researchQueries: [...plea.researchQueries, ...additionalQueries],
      material: true,
    };
    const inputSha256 = researchInputHash(corpus, issue, asOf, factRecords, model.config.localModel);
    return cachedResearch(previous, issue.id, inputSha256) ?? researchIssue(corpus, model, issue, asOf, factRecords);
  });
}
