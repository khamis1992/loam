import crypto from "node:crypto";
import type { LegalCorpus } from "../corpusStore.js";
import type { FactAssertion } from "../evidence/types.js";
import type { LegalIssue, ResearchRecord } from "./types.js";

export const RESEARCH_PROMPT_VERSION = "1";

export function researchInputHash(corpus: LegalCorpus, issue: LegalIssue, asOf: string, factRecords: Array<Pick<FactAssertion, "id" | "text" | "kind" | "status">>, model: string): string {
  const evidence = factRecords.filter((fact) => issue.facts.includes(fact.id));
  const snapshot = corpus.snapshot({ persist: false }).id;
  return crypto.createHash("sha256").update(JSON.stringify({ issue, evidence, asOf, snapshot, model, promptVersion: RESEARCH_PROMPT_VERSION })).digest("hex");
}

export async function mapResearchTasks<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(2, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

export function cachedResearch(previous: ResearchRecord[], issueId: string, inputSha256: string): ResearchRecord | undefined {
  return previous.find((record) => record.issueId === issueId && record.inputSha256 === inputSha256);
}
