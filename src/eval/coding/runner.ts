/** The headless coding-eval runner (task C18).
 *
 *  Each fixture is materialized into a throwaway sandbox, optionally handed to
 *  the real Loam coding agent, then graded by running the fixture's hidden test
 *  command and reading its exit code. Three modes share one code path:
 *
 *    - `self-check` applies the reference solution; a pass proves the fixture and
 *      its hidden test agree.
 *    - `baseline` runs the untouched tree and expects the hidden test to FAIL,
 *      which proves the fixture actually measures something.
 *    - `agent` runs the coding agent and records pass@1.
 *
 *  Grading is a process exit code plus a few file assertions, so the suite is
 *  deterministic and needs no model to be validated.
 */
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "../../config.js";
import type { Config } from "../../config.js";
import { log } from "../../log.js";
import { codingTaskTools } from "../../agent/taskToolScope.js";
import type { Emit } from "../../agent/events.js";
import { runAgent } from "../../agent/loop.js";
import type { OllamaClient } from "../../ollama.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { codingEvalsDir, loadTask } from "./tasks.js";
import type {
  CodingRunReport,
  CodingTask,
  EvalMode,
  FileMap,
  GradeCheck,
  RunCodingEvalOptions,
  TaskResult,
} from "./types.js";

/** Where hidden tests are materialized at grade time. They are never present
 *  while the agent runs, so the agent cannot read or edit the grader. */
export const HIDDEN_DIR = ".eval";

const DEFAULT_TEST_TIMEOUT_SEC = 60;
const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_CHARS = 2_000;

export interface CommandOutcome {
  code: number;
  output: string;
  timedOut: boolean;
}

/** Run one shell command in `cwd`. Injectable so tests never spawn shells. */
export type CommandRunner = (cmd: string, opts: { cwd: string; timeoutMs: number }) => Promise<CommandOutcome>;

export const defaultCommandRunner: CommandRunner = (cmd, opts) =>
  new Promise((resolve) => {
    exec(
      cmd,
      { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const timedOut = Boolean(err && (err as { killed?: boolean }).killed);
        resolve({ code, output: `${stdout ?? ""}${stderr ?? ""}`, timedOut });
      },
    );
  });

/** Write a relative-path file map into a root, creating parent directories. */
export function materialize(root: string, files: FileMap): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
}

/** Fresh sandbox for one task: a copy of the fixture tree plus hidden tests. */
export function prepareSandbox(workDir: string, task: CodingTask, overlay?: FileMap): string {
  const sandbox = path.join(workDir, task.id);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
  materialize(sandbox, task.files);
  if (overlay) materialize(sandbox, overlay);
  ensureEsm(sandbox);
  return sandbox;
}

/** Fixtures are ESM. Supply `{"type":"module"}` when the tree does not ship a
 *  package.json, so `import`/`export` in `.js` and `.ts` files resolves. */
function ensureEsm(sandbox: string): void {
  if (fs.existsSync(path.join(sandbox, "package.json"))) return;
  const hasJs = ["src", "test", "."].some((dir) =>
    safeList(dir === "." ? sandbox : path.join(sandbox, dir)).some((f) => /\.(?:m?js|ts)$/.test(f)),
  );
  if (!hasJs) return;
  fs.writeFileSync(path.join(sandbox, "package.json"), '{ "type": "module", "private": true }\n', "utf8");
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function tail(text: string, chars = OUTPUT_TAIL_CHARS): string {
  return text.length <= chars ? text : text.slice(-chars);
}

/** Run the fixture's hidden tests against a sandbox and collect every check. */
export async function gradeTask(
  task: CodingTask,
  sandbox: string,
  run: CommandRunner,
): Promise<{ checks: GradeCheck[]; exitCode?: number; timedOut?: boolean; output: string; ok: boolean }> {
  const checks: GradeCheck[] = [];

  for (const rel of task.requireFiles ?? []) {
    const ok = fs.existsSync(path.join(sandbox, rel));
    checks.push({ name: `require:${rel}`, ok, detail: ok ? "present" : "missing" });
  }

  materialize(path.join(sandbox, HIDDEN_DIR), task.tests);

  const timeoutSec = task.timeoutSec ?? DEFAULT_TEST_TIMEOUT_SEC;
  const outcome = await run(task.testCommand, { cwd: sandbox, timeoutMs: timeoutSec * 1000 });
  const expectExit = task.expectExit ?? 0;
  checks.push({
    name: "test-command",
    ok: outcome.code === expectExit,
    detail: `exit ${outcome.code} (expected ${expectExit})${outcome.timedOut ? ", timed out" : ""}`,
  });

  for (const rule of task.forbidPatterns ?? []) {
    const abs = path.join(sandbox, rule.path);
    let detail = "file missing";
    let ok = false;
    try {
      const body = fs.readFileSync(abs, "utf8");
      const hit = new RegExp(rule.pattern, rule.flags ?? "").test(body);
      ok = !hit;
      detail = hit ? `forbidden pattern present: ${rule.pattern}` : "clean";
    } catch {
      detail = "file unreadable";
    }
    checks.push({ name: `forbid:${rule.path}:${rule.pattern}`, ok, detail });
  }

  return {
    checks,
    exitCode: outcome.code,
    timedOut: outcome.timedOut,
    output: tail(outcome.output),
    ok: checks.every((c) => c.ok),
  };
}

/** Build a stub emitter so headless runs never touch a UI. */
function silentEmit(): Emit {
  return () => {};
}

export interface AgentRunnerDeps {
  cfg: Config;
  ollama: OllamaClient;
  registry: ToolRegistry;
}

/** Run the real coding agent inside a sandbox and return its step/model usage. */
async function runCodingAgent(
  deps: AgentRunnerDeps,
  task: CodingTask,
  sandbox: string,
  opts: RunCodingEvalOptions,
): Promise<{ steps: number; model: string; error?: string }> {
  const cfg: Config = { ...deps.cfg, workspace: sandbox };
  const signals: AbortSignal[] = [];
  if (opts.signal) signals.push(opts.signal);
  signals.push(AbortSignal.timeout(opts.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS));
  try {
    const result = await runAgent({
      cfg,
      ollama: deps.ollama,
      tools: codingTaskTools(deps.registry),
      emit: silentEmit(),
      prompt: task.prompt,
      maxSteps: opts.maxSteps ?? task.maxSteps,
      suppressFinal: opts.suppressFinal ?? true,
      signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
    });
    return { steps: result.steps, model: result.model };
  } catch (err) {
    return { steps: 0, model: cfg.model, error: err instanceof Error ? err.message : String(err) };
  }
}

function emptyResult(task: CodingTask, error: string): TaskResult {
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    language: task.language,
    status: "error",
    score: 0,
    durationMs: 0,
    error,
    checks: [],
  };
}

/** Run one task end to end and return its graded result. */
export async function runTask(
  task: CodingTask,
  options: RunCodingEvalOptions & { run?: CommandRunner; agent?: AgentRunnerDeps },
): Promise<TaskResult> {
  const started = Date.now();
  const run = options.run ?? defaultCommandRunner;
  const workDir = options.workDir ?? path.join(codingEvalsDir(), "results");
  const base: Omit<TaskResult, "status" | "score" | "checks" | "durationMs"> = {
    id: task.id,
    title: task.title,
    category: task.category,
    language: task.language,
  };

  let sandbox: string;
  try {
    sandbox = prepareSandbox(workDir, task, options.mode === "self-check" ? task.reference : undefined);
  } catch (err) {
    return emptyResult(task, `sandbox setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let agentInfo: { steps: number; model: string; error?: string } | undefined;
  if (options.mode === "agent") {
    if (!options.agent) return emptyResult(task, "agent mode requires a runtime (cfg, ollama, registry)");
    agentInfo = await runCodingAgent(options.agent, task, sandbox, options);
  }

  let graded: Awaited<ReturnType<typeof gradeTask>>;
  try {
    graded = await gradeTask(task, sandbox, run);
  } catch (err) {
    return { ...base, status: "error", score: 0, durationMs: Date.now() - started, checks: [], error: err instanceof Error ? err.message : String(err) };
  }

  const result: TaskResult = {
    ...base,
    status: graded.ok ? "pass" : "fail",
    score: graded.ok ? 1 : 0,
    durationMs: Date.now() - started,
    checks: graded.checks,
    ...(graded.exitCode !== undefined ? { exitCode: graded.exitCode } : {}),
    ...(graded.timedOut !== undefined ? { timedOut: graded.timedOut } : {}),
    ...(graded.output ? { testOutput: graded.output } : {}),
    ...(agentInfo ? { steps: agentInfo.steps, model: agentInfo.model } : {}),
    ...(agentInfo?.error ? { error: agentInfo.error } : {}),
  };
  return result;
}

/** `baseline` mode inverts the verdict: the untouched tree must FAIL the test.
 *  Exported so the mode contract can be unit tested without a full run. */
export function scoreForMode(mode: EvalMode, result: TaskResult): TaskResult {
  if (mode !== "baseline") return result;
  const meaningful = result.status === "fail";
  return {
    ...result,
    status: meaningful ? "pass" : "fail",
    score: meaningful ? 1 : 0,
    checks: [
      ...result.checks,
      {
        name: "fixture-is-meaningful",
        ok: meaningful,
        detail: meaningful ? "hidden test fails on the untouched tree" : "hidden test already passes without a fix",
      },
    ],
  };
}

/** Run every selected task and aggregate a pass@1 report. */
export async function runCodingEval(
  options: RunCodingEvalOptions & { run?: CommandRunner; agent?: AgentRunnerDeps },
): Promise<CodingRunReport> {
  const ids = options.only && options.only.length > 0 ? options.only : undefined;
  const tasks = ids ? ids.map((id) => loadTask(id).task) : listAll();
  const startedAt = new Date();
  const started = Date.now();
  const workDir = options.workDir ?? path.join(codingEvalsDir(), "results");
  fs.mkdirSync(workDir, { recursive: true });

  const results: TaskResult[] = [];
  for (const task of tasks) {
    if (options.signal?.aborted) {
      results.push({ ...emptyResult(task, "run aborted"), status: "skipped" });
      continue;
    }
    log.info(`coding-eval: ${task.id} (${task.category})`);
    const result = scoreForMode(options.mode, await runTask(task, { ...options, workDir }));
    results.push(result);
    options.onTask?.(result);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const denominator = results.length - skipped;
  const finishedAt = new Date();

  return {
    id: randomUUID(),
    mode: options.mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model: options.agent?.cfg.model ?? options.model ?? "n/a",
    passAt1: denominator > 0 ? passed / denominator : 0,
    total: results.length,
    passed,
    failed,
    errors,
    skipped,
    durationMs: Date.now() - started,
    results,
  };
}

/** Load every valid fixture task, in id order. */
function listAll(): CodingTask[] {
  return loadTaskIds().map((id) => loadTask(id).task);
}

function loadTaskIds(): string[] {
  const dir = path.join(codingEvalsDir(), "tasks");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "task.json")))
    .map((e) => e.name)
    .sort();
}

/** Default results directory (gitignored, inside the repo). */
export function defaultResultsDir(): string {
  return path.join(ROOT, "evals", "coding", "results");
}

/** Temporary sandbox root outside the repo, for one-off runs. */
export function tempSandboxRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loam-coding-eval-"));
}
