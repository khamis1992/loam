import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAvid } from "../corpusStore.js";
import { evaluateRetrieval } from "../evaluation/retrievalMetrics.js";
import { loadFixtureCorpus } from "./helpers.js";

test("retrieval evaluation reports recall, MRR and failures", async () => {
  const corpus = loadFixtureCorpus();
  const result = await evaluateRetrieval(corpus, [
    { id: "hit", query: "المادة 2 من القانون المدني الاختباري", asOf: "2090-05-01", expectedAvids: [makeAvid("law/2090/1:body:2", "2090-04-01")] },
    { id: "miss", query: "نص لا وجود له", asOf: "2090-05-01", expectedAvids: ["QL-ffffffffff"] },
  ]);
  assert.equal(result.recallAtK, 0.5);
  assert.equal(result.mrr, 0.25);
  assert.deepEqual(result.failures.map((f) => f.id), ["miss"]);
  corpus.close();
});
