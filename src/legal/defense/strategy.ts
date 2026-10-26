import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { researchIssue } from "../analysis/legalResearch.js";
import type { LegalModelPort } from "../model/types.js";
import type { ResearchRecord } from "../analysis/types.js";
import type { CaseTheory } from "./types.js";

export async function researchDefense(corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, theory: CaseTheory, asOf: string): Promise<ResearchRecord[]> {
  const records: ResearchRecord[] = [];
  for (const plea of theory.pleas) {
    records.push(await researchIssue(corpus, model, {
      id: plea.id,
      title: plea.title,
      kind: plea.type === "procedural" ? "procedural" : plea.type === "evidentiary" ? "evidentiary" : "substantive",
      facts: plea.factIds,
      researchQueries: plea.researchQueries,
      material: true,
    }, asOf));
  }
  return records;
}
