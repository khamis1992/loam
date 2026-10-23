import assert from "node:assert";
import { describe, it } from "node:test";
import type { Config } from "../../config.js";
import { codingProviders } from "../../llm/codingRouter.js";
import type { EvalRun, EvalSuite } from "../types.js";
import {
  benchmarkCandidates,
  buildBenchmarkReport,
  formatBenchmarkReport,
  runCodingBenchmark,
  summarizeBenchmarkModel,
} from "../codingBenchmark.js";

const suite: EvalSuite = {
  id: "coding",
  name: "Coding eval",
  version: 1,
  cases: [
    { id: "bug-fix", prompt: "fix", verify: [] },
    { id: "refactor", prompt: "refactor", verify: [] },
    { id: "add-test", prompt: "add test", verify: [] },
  ],
};

function caseResult(id: string, status: EvalRun["cases"][number]["status"], durationMs = 100): EvalRun["cases"][number] {
  return {
    id,
    prompt: id,
    status,
    score: status === "pass" ? 1 : 0,
    steps: 3,
    durationMs,
    usage: { promptTokens: 10, completionTokens: 10 },
    checkpoints: [],
    finalText: "",
    critique: null,
  };
}

function run(statuses: Record<string, EvalRun["cases"][number]["status"]>): EvalRun {
  return {
    id: "run-1",
    suiteId: suite.id,
    suiteName: suite.name,
    model: "m",
    startedAt: "2026-10-22T00:00:00.000Z",
    finishedAt: "2026-10-22T00:01:00.000Z",
    summary: { pass: 0, fail: 0, error: 0, skipped: 0, passRate: 0, cases: 0 },
    cases: suite.cases.map((c) => caseResult(c.id, statuses[c.id] ?? "fail")),
  };
}

describe("benchmark summarization", () => {
  it("computes pass rate per model", () => {
    const row = summarizeBenchmarkModel("longcat", "longcat", "config", run({ "bug-fix": "pass", "refactor": "pass", "add-test": "fail" }));
    assert.equal(row.pass, 2);
    assert.equal(row.fail, 1);
    assert.equal(row.error, 0);
    assert.equal(row.total, 3);
    assert.ok(Math.abs(row.passRate - 2 / 3) < 1e-9);
  });

  it("counts errors and skips against the model", () => {
    const row = summarizeBenchmarkModel("m", "p", "env", run({ "bug-fix": "pass", "refactor": "error", "add-test": "skipped" }));
    assert.equal(row.error, 1);
    assert.equal(row.skipped, 1);
    assert.equal(row.passRate, 1 / 3);
  });

  it("builds a report listing the pass rate per model and picks the best", () => {
    const weak = summarizeBenchmarkModel("weak", "p1", "config", run({ "bug-fix": "pass", "refactor": "fail", "add-test": "fail" }));
    const strong = summarizeBenchmarkModel("strong", "p2", "config", run({ "bug-fix": "pass", "refactor": "pass", "add-test": "fail" }));
    const report = buildBenchmarkReport(suite, "2026-10-22T00:00:00.000Z", [weak, strong]);

    assert.equal(report.models.length, 2);
    assert.equal(report.models[0]!.model, "strong");
    assert.equal(report.best?.model, "strong");
    assert.equal(report.best?.passRate, 2 / 3);
    assert.ok(report.models.every((m) => typeof m.passRate === "number"));
  });

  it("renders a markdown table with a pass rate per model", () => {
    const row = summarizeBenchmarkModel("longcat", "longcat", "config", run({ "bug-fix": "pass", "refactor": "pass", "add-test": "pass" }));
    const markdown = formatBenchmarkReport(buildBenchmarkReport(suite, "t", [row]));
    assert.match(markdown, /\| longcat \| longcat \| 3 \| 0 \| 0 \| 0 \| 3 \| 100\.0% \|/);
    assert.match(markdown, /Best coder: \*\*longcat\*\*/);
  });
});

describe("runCodingBenchmark", () => {
  const cfg = {
    model: "weak",
    coding: { enabled: true, chain: ["strong", "weak"], logEdits: true },
    failover: {
      providers: [
        { id: "strong-p", kind: "openai-compatible", baseUrl: "http://strong/v1", model: "strong", apiKeyEnv: "S_KEY", enabled: true },
        { id: "weak-p", kind: "openai-compatible", baseUrl: "http://weak/v1", model: "weak", apiKeyEnv: "W_KEY", enabled: true },
      ],
    },
  } as unknown as Config;

  it("runs every candidate coder and reports pass rate per model", async () => {
    const seen: string[] = [];
    const report = await runCodingBenchmark({
      cfg,
      suite,
      env: { S_KEY: "s", W_KEY: "w" },
      runSuiteForModel: async (model, providerId) => {
        seen.push(`${providerId}:${model}`);
        return run({
          "bug-fix": model === "strong" ? "pass" : "fail",
          "refactor": model === "strong" ? "pass" : "pass",
          "add-test": "pass",
        });
      },
    });

    assert.deepEqual(seen, ["strong-p:strong", "weak-p:weak"]);
    assert.equal(report.models.length, 2);
    assert.equal(report.best?.model, "strong");
    assert.equal(report.models.find((m) => m.model === "strong")!.passRate, 1);
    assert.equal(report.models.find((m) => m.model === "weak")!.passRate, 2 / 3);
  });

  it("derives candidates from the coding chain", () => {
    assert.deepEqual(benchmarkCandidates(cfg, { S_KEY: "s", W_KEY: "w" }), [
      { model: "strong", providerId: "strong-p" },
      { model: "weak", providerId: "weak-p" },
    ]);
  });

  it("exposes the coding provider order for the chain", () => {
    assert.deepEqual(codingProviders(cfg, { S_KEY: "s", W_KEY: "w" }).map((p) => p.id), ["strong-p", "weak-p"]);
  });
});
