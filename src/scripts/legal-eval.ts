import fs from "node:fs";
import { makeAvid } from "../legal/corpusStore.js";
import { evaluateRetrieval } from "../legal/evaluation/retrievalMetrics.js";
import { compareLegalEvaluations, evaluateLegalDataset } from "../legal/evaluation/dataset.js";
import { loadFixtureCorpus } from "../legal/__tests__/helpers.js";

const datasetFlag = process.argv.indexOf("--dataset");
if (datasetFlag >= 0) {
  const file = process.argv[datasetFlag + 1];
  if (!file) throw new Error("--dataset requires a JSON file containing evaluation results, not confidential matter data");
  const evaluation = evaluateLegalDataset(JSON.parse(fs.readFileSync(file, "utf8")));
  const baselineFlag = process.argv.indexOf("--baseline");
  const baselineFile = baselineFlag >= 0 ? process.argv[baselineFlag + 1] : undefined;
  if (baselineFlag >= 0 && !baselineFile) throw new Error("--baseline requires a previously accepted evaluation JSON file");
  const comparison = baselineFile ? compareLegalEvaluations(evaluation, evaluateLegalDataset(JSON.parse(fs.readFileSync(baselineFile, "utf8")))) : undefined;
  console.log(JSON.stringify({ suite: "professional-frozen-evaluation", ...evaluation, ...(comparison ? { comparison } : {}) }, null, 2));
  if (!evaluation.pass || comparison?.pass === false) process.exitCode = 1;
} else {
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
}
