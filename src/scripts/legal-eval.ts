import { makeAvid } from "../legal/corpusStore.js";
import { evaluateRetrieval } from "../legal/evaluation/retrievalMetrics.js";
import { loadFixtureCorpus } from "../legal/__tests__/helpers.js";

const corpus = loadFixtureCorpus();
try {
  const result = await evaluateRetrieval(corpus, [
    { id: "direct-arabic", query: "المادة 2 من القانون المدني الاختباري", asOf: "2090-05-01", expectedAvids: [makeAvid("law/2090/1:body:2", "2090-04-01")] },
    { id: "temporal-old-version", query: "المادة 3 من القانون المدني الاختباري", asOf: "2091-01-01", expectedAvids: [makeAvid("law/2090/1:body:3", "2090-04-01")] },
    { id: "temporal-amended-version", query: "المادة 3 من القانون المدني الاختباري", asOf: "2092-01-01", expectedAvids: [makeAvid("law/2090/1:body:3", "2091-07-01")] },
  ]);
  console.log(JSON.stringify({ suite: "synthetic-retrieval-smoke", ...result }, null, 2));
  if (result.failures.length > 0) process.exitCode = 1;
} finally {
  corpus.close();
}
