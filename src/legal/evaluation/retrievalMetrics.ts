import type { LegalCorpus } from "../corpusStore.js";
import { searchLaw } from "../retrieval.js";

export interface RetrievalEvalCase {
  id: string;
  query: string;
  asOf: string;
  expectedAvids: string[];
  matterKind?: string;
}

export interface RetrievalEvalResult {
  cases: number;
  recallAtK: number;
  mrr: number;
  failures: Array<{ id: string; expectedAvids: string[]; actualAvids: string[] }>;
}

export async function evaluateRetrieval(corpus: LegalCorpus, cases: RetrievalEvalCase[], k = 5): Promise<RetrievalEvalResult> {
  if (cases.length === 0) throw new Error("retrieval evaluation requires cases");
  const failures: RetrievalEvalResult["failures"] = [];
  let recall = 0;
  let reciprocalRank = 0;
  for (const item of cases) {
    const result = await searchLaw(corpus, item.query, { asOf: item.asOf, k, ...(item.matterKind ? { matterKind: item.matterKind } : {}) });
    const actual = result.hits.map((hit) => hit.avid);
    const ranks = item.expectedAvids.map((avid) => actual.indexOf(avid)).filter((rank) => rank >= 0);
    if (ranks.length > 0) {
      recall++;
      reciprocalRank += 1 / (Math.min(...ranks) + 1);
    } else {
      failures.push({ id: item.id, expectedAvids: item.expectedAvids, actualAvids: actual });
    }
  }
  return { cases: cases.length, recallAtK: recall / cases.length, mrr: reciprocalRank / cases.length, failures };
}
