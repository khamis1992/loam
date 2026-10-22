/**
 * Coding benchmark (C17).
 *
 * Runs the coding eval set (the C11 fixtures, suite id "coding") once per
 * candidate coder and writes a report that lists the pass rate per model. This
 * is the measuring stick for the coding-model routing decision: it answers
 * "which model in the chain actually solves the most coding tasks?".
 *
 * The module is provider-agnostic: the caller supplies `runSuiteForModel`, so
 * the real CLI wires a runtime per model while tests inject a fake runner.
 */
import type { Config } from "../config.js";
import { log } from "../log.js";
import { codingProviders, coderChainIds } from "../llm/codingRouter.js";
import type { FailoverProvider } from "../llm/failover.js";
import type { CoderChainSource } from "../llm/codingRouter.js";
import type { EvalRun, EvalSuite } from "./types.js";

export interface BenchmarkCaseResult {
  model: string;
  providerId: string;
  caseId: string;
  status: EvalRun["cases"][number]["status"];
  score: number;
  steps: number;
  durationMs: number;
  error?: string;
}

export interface BenchmarkModelResult {
  model: string;
  providerId: string;
  chainSource: CoderChainSource;
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  total: number;
  /** pass / total (skipped cases count against the model). */
  passRate: number;
  durationMs: number;
  cases: BenchmarkCaseResult[];
}

export interface BenchmarkReport {
  suiteId: string;
  suiteName: string;
  startedAt: string;
  finishedAt: string;
  models: BenchmarkModelResult[];
  best?: { model: string; passRate: number; providerId: string };
}

export interface CodingBenchmarkOptions {
  cfg: Config;
  suite: EvalSuite;
  env?: Record<string, string | undefined>;
  caseFilter?: string;
  /** Candidate coders. Defaults to the configured coding chain. */
  candidates?: Array<{ model: string; providerId: string }>;
  /** Runs one model over the whole suite. Required. */
  runSuiteForModel: (model: string, providerId: string, suite: EvalSuite, caseFilter?: string) => Promise<EvalRun>;
  onModelStart?: (info: { model: string; providerId: string; index: number; total: number }) => void;
}

/** Aggregate one suite run into a per-model benchmark row. */
export function summarizeBenchmarkModel(
  model: string,
  providerId: string,
  chainSource: CoderChainSource,
  run: EvalRun,
): BenchmarkModelResult {
  const cases: BenchmarkCaseResult[] = run.cases.map((c) => ({
    model,
    providerId,
    caseId: c.id,
    status: c.status,
    score: c.score,
    steps: c.steps,
    durationMs: c.durationMs,
    ...(c.error ? { error: c.error } : {}),
  }));
  const pass = cases.filter((c) => c.status === "pass").length;
  const fail = cases.filter((c) => c.status === "fail").length;
  const error = cases.filter((c) => c.status === "error").length;
  const skipped = cases.filter((c) => c.status === "skipped").length;
  const total = cases.length;
  return {
    model,
    providerId,
    chainSource,
    pass,
    fail,
    error,
    skipped,
    total,
    passRate: total > 0 ? pass / total : 0,
    durationMs: cases.reduce((sum, c) => sum + c.durationMs, 0),
    cases,
  };
}

/** Build the full report and pick the best model (pass rate, then speed). */
export function buildBenchmarkReport(suite: EvalSuite, startedAt: string, models: BenchmarkModelResult[]): BenchmarkReport {
  const ordered = [...models].sort((a, b) => b.passRate - a.passRate || a.durationMs - b.durationMs);
  const best = ordered[0];
  return {
    suiteId: suite.id,
    suiteName: suite.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    models: ordered,
    ...(best && best.total > 0 ? { best: { model: best.model, passRate: best.passRate, providerId: best.providerId } } : {}),
  };
}

/** Markdown report: one row per model with its pass rate. */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [
    `# Coding benchmark — ${report.suiteName} (${report.suiteId})`,
    "",
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    "",
    "| Model | Provider | Pass | Fail | Error | Skipped | Total | Pass rate | Duration |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const m of report.models) {
    lines.push(
      `| ${m.model} | ${m.providerId} | ${m.pass} | ${m.fail} | ${m.error} | ${m.skipped} | ${m.total} | ${(m.passRate * 100).toFixed(1)}% | ${(m.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  if (report.best) {
    lines.push("", `Best coder: **${report.best.model}** (${(report.best.passRate * 100).toFixed(1)}% pass rate).`);
  }
  return `${lines.join("\n")}\n`;
}

/** Resolve the candidate coders: the configured chain, or the main model.
 *  The reported model is the configured coder id; the `:cloud` request marker is
 *  applied per provider by the caller when it builds the runtime. */
export function benchmarkCandidates(
  cfg: Config,
  env: Record<string, string | undefined> = process.env,
): Array<{ model: string; providerId: string }> {
  const providers = codingProviders(cfg, env);
  if (providers.length === 0) return [{ model: cfg.model, providerId: "default" }];
  return providers.map((p) => ({ model: p.model, providerId: p.id }));
}

/** Run every candidate coder over the suite and build the report. */
export async function runCodingBenchmark(options: CodingBenchmarkOptions): Promise<BenchmarkReport> {
  const env = options.env ?? process.env;
  const candidates = options.candidates ?? benchmarkCandidates(options.cfg, env);
  if (candidates.length === 0) throw new Error("coding benchmark: no candidate models");

  const startedAt = new Date().toISOString();
  const chainSource = coderChainIds(options.cfg, env).source;
  const results: BenchmarkModelResult[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    options.onModelStart?.({ model: candidate.model, providerId: candidate.providerId, index: i + 1, total: candidates.length });
    log.info(`coding benchmark: ${candidate.model} (${candidate.providerId}) ${i + 1}/${candidates.length}`);
    const run = await options.runSuiteForModel(candidate.model, candidate.providerId, options.suite, options.caseFilter);
    results.push(summarizeBenchmarkModel(candidate.model, candidate.providerId, chainSource, run));
  }
  return buildBenchmarkReport(options.suite, startedAt, results);
}

export type { FailoverProvider };
