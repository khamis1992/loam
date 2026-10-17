import fs from "node:fs";
import path from "node:path";
import { newId } from "../server/db.js";
import { log } from "../log.js";
import { appendLearning } from "../server/learning.js";
import { appendCritique, appendTelemetry, hashPrompt, saveTranscript } from "../telemetry/store.js";
import { runAgent, type RunOptions, type RunResult } from "../agent/loop.js";
import type { OllamaClient } from "../ollama.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Config } from "../config.js";
import { safeResolve, runVerifiers } from "./verify.js";
import { beginRun, computeSummary, finishRun, lastRunForSuite, pruneRuns, pushCaseResult } from "./store.js";
import { critiqueCase } from "../learning/critic.js";
import type { CaseResult, CaseStatus, EvalCase, EvalRun, EvalRunSummary, EvalSuite } from "./types.js";

export interface EvalDeps {
  cfg: Config;
  ollama: OllamaClient;
  registry: ToolRegistry;
  runAgentFn?: (opts: RunOptions) => Promise<RunResult>;
  critique?: boolean;
  offline?: boolean;
}

export interface ProgressEvent {
  runId: string;
  caseId?: string;
  index: number;
  total: number;
  phase: "start" | "case-start" | "case-done" | "done";
  result?: CaseResult;
  summary?: EvalRun["summary"];
}

export interface RunSuiteOptions {
  suite: EvalSuite;
  deps: EvalDeps;
  runId?: string;
  caseFilter?: string;
  onProgress?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
}

export function sandboxRoot(cfg: Config): string {
  return path.join(cfg.workspace, "eval-runs");
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

interface CaseOutcome {
  result: CaseResult;
  model: string;
}

async function runCase(
  c: EvalCase,
  suite: EvalSuite,
  deps: EvalDeps,
  runId: string,
  outerSignal: AbortSignal | undefined,
): Promise<CaseOutcome> {
  const cfg = deps.cfg;
  const agentFn = deps.runAgentFn ?? runAgent;
  const sandbox = path.join(sandboxRoot(cfg), runId, sanitizeId(c.id));

  if (c.network === true && (deps.offline === true || !cfg.policy.networkEnabled)) {
    return {
      model: cfg.model,
      result: {
        id: c.id,
        prompt: c.prompt,
        status: "skipped",
        score: 0,
        steps: 0,
        durationMs: 0,
        usage: { promptTokens: 0, completionTokens: 0 },
        checkpoints: [{ type: "network_skipped", ok: false, detail: "حالة شبكية — تم التخطي (offline)" }],
        finalText: "",
        critique: null,
      },
    };
  }

  fs.mkdirSync(sandbox, { recursive: true });
  for (const s of c.setup ?? []) {
    const full = safeResolve(sandbox, s.path);
    if (!full) throw new Error(`مسار setup خارج مجلد الحالة: ${s.path} (${c.id})`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, s.text, "utf8");
  }

  const caseCfg: Config = {
    ...cfg,
    workspace: sandbox,
    agent: { ...cfg.agent, maxSteps: c.budget?.maxSteps ?? cfg.agent.maxSteps },
  };
  const timeoutSec = c.budget?.timeoutSec ?? 300;
  const trace: Array<{ name: string; ok: boolean; ms?: number }> = [];
  const emit: RunOptions["emit"] = (e) => {
    if (e.type === "tool_result") trace.push({ name: e.name, ok: e.ok, ms: e.ms });
  };

  const signals: AbortSignal[] = [];
  if (outerSignal) signals.push(outerSignal);
  signals.push(AbortSignal.timeout(timeoutSec * 1000));
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  const t0 = Date.now();
  let finalText = "";
  let steps = 0;
  let usage = { promptTokens: 0, completionTokens: 0 };
  let model = cfg.model;
  let messages: RunResult["messages"] = [];
  let status: CaseStatus = "pass";
  let error: string | undefined;

  try {
    const result = await agentFn({ cfg: caseCfg, ollama: deps.ollama, tools: deps.registry, emit, prompt: c.prompt, signal });
    finalText = result.text;
    steps = result.steps;
    usage = { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens };
    model = result.model;
    messages = result.messages;
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  let checkpoints: CaseResult["checkpoints"];
  if (status === "error") {
    checkpoints = [{ type: "run_error", ok: false, detail: error ?? "unknown error" }];
  } else {
    checkpoints = await runVerifiers(c.verify, {
      workspace: sandbox,
      finalText,
      trace,
      cfg,
      ollama: deps.ollama,
    });
    if (!checkpoints.every((p) => p.ok)) status = "fail";
  }

  let critique = null;
  if (deps.critique !== false && status !== "error") {
    critique = await critiqueCase({ cfg, ollama: deps.ollama, prompt: c.prompt, finalText, trace, checkpoints, status, error });
    try {
      appendCritique({ at: new Date().toISOString(), runId, caseId: c.id, model, critique });
    } catch {
      /* best-effort */
    }
  }

  if (cfg.evaluation.transcripts && messages.length > 0) {
    const msgs = [...messages];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant" || last.content !== finalText) msgs.push({ role: "assistant", content: finalText });
    try {
      saveTranscript(`${runId}_${c.id}`, {
        prompt: c.prompt,
        finalText,
        messages: msgs,
        trace,
        meta: { suiteId: suite.id, caseId: c.id, model, status },
      });
    } catch {
      /* best-effort */
    }
  }

  const result: CaseResult = {
    id: c.id,
    prompt: c.prompt,
    status,
    score: status === "pass" ? 1 : 0,
    steps,
    durationMs: Date.now() - t0,
    ...(error ? { error } : {}),
    usage,
    checkpoints,
    finalText: finalText.slice(0, 4000),
    critique,
  };

  appendTelemetry({
    at: new Date().toISOString(),
    kind: "eval-case",
    runId,
    caseId: c.id,
    model,
    status: status === "error" ? "error" : "done",
    steps,
    durationMs: result.durationMs,
    usage,
    toolCalls: trace.map((t) => ({ name: t.name, ok: t.ok, ...(t.ms !== undefined ? { ms: t.ms } : {}) })),
    promptHash: hashPrompt(c.prompt),
    promptChars: c.prompt.length,
    ...(status === "pass" || status === "fail" ? { passed: status === "pass" } : {}),
    score: result.score,
    ...(error ? { error } : {}),
  });

  return { result, model };
}

function checkRegression(suiteId: string, prev: EvalRunSummary | undefined, current: EvalRunSummary): void {
  if (!prev || prev.summary.cases < 4) return;
  const drop = prev.summary.passRate - current.summary.passRate;
  if (drop >= 0.2) {
    const msg = `انحدار في ${suiteId}: passRate ${(prev.summary.passRate * 100).toFixed(0)}% → ${(current.summary.passRate * 100).toFixed(0)}%`;
    log.warn(`eval regression: ${msg}`);
    appendLearning({ at: new Date().toISOString(), task: `(eval regression) ${suiteId}`, applied: [msg] });
  }
}

export async function runSuite(opts: RunSuiteOptions): Promise<EvalRun> {
  const { suite, deps } = opts;
  const cfg = deps.cfg;
  const runId = opts.runId ?? newId("eval");
  const cases = opts.caseFilter ? suite.cases.filter((c) => c.id === opts.caseFilter) : suite.cases;
  if (cases.length === 0) {
    throw new Error(`لا توجد حالات مطابقة (suite=${suite.id}${opts.caseFilter ? `, case=${opts.caseFilter}` : ""})`);
  }

  pruneRuns(cfg.evaluation.keepRuns);
  const run: EvalRun = {
    id: runId,
    suiteId: suite.id,
    suiteName: suite.name,
    model: cfg.model,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    summary: { pass: 0, fail: 0, error: 0, skipped: 0, passRate: 0, cases: 0 },
    cases: [],
  };
  beginRun(run);
  opts.onProgress?.({ runId, index: 0, total: cases.length, phase: "start" });

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!c) continue;
    opts.onProgress?.({ runId, caseId: c.id, index: i + 1, total: cases.length, phase: "case-start" });
    const outcome = await runCase(c, suite, deps, runId, opts.signal);
    run.model = outcome.model;
    pushCaseResult(outcome.result);
    opts.onProgress?.({ runId, caseId: c.id, index: i + 1, total: cases.length, phase: "case-done", result: outcome.result });
  }

  run.finishedAt = new Date().toISOString();
  run.summary = computeSummary(run.cases);
  const prev = lastRunForSuite(suite.id);
  const summary = finishRun(run);
  checkRegression(suite.id, prev, summary);
  opts.onProgress?.({ runId, index: cases.length, total: cases.length, phase: "done", summary: run.summary });
  return run;
}
