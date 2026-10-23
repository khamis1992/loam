/** Types for the headless coding-eval harness (task C18).
 *
 *  The harness measures the Loam coding agent on small, self-contained fixture
 *  repositories. Each fixture is one `evals/coding/tasks/<id>/` directory with a
 *  `task.json` (metadata) plus `files/` (starting tree), `tests/` (hidden tests)
 *  and `reference/` (solution overlay). Grading is a plain process exit code, so
 *  the suite is fully offline and deterministic: no model is needed to validate
 *  it.
 */

export type TaskCategory = "bug-fix" | "refactor" | "add-test";
export type TaskLanguage = "javascript" | "typescript" | "python";
export type TaskStatus = "pass" | "fail" | "error" | "skipped";

/** A regular expression that must NOT appear in a file after the agent runs.
 *  Used to catch trivia (for example a test that only asserts `true`). */
export interface ForbidPattern {
  path: string;
  pattern: string;
  flags?: string;
}

/** Relative path -> file contents. Every fixture tree is declared this way. */
export type FileMap = Record<string, string>;

/** The declarative definition of one fixture repo. Mirrors `task.json`. */
export interface CodingTask {
  id: string;
  title: string;
  category: TaskCategory;
  language: TaskLanguage;
  prompt: string;
  /** Shell command executed with the sandbox root as its working directory. */
  testCommand: string;
  /** Starting tree, read from `files/` at load time. */
  files: FileMap;
  /** Hidden tests, read from `tests/`; materialized under `.eval/` only while grading. */
  tests: FileMap;
  /** Solution overlay, read from `reference/`; applied over `files` in self-check mode. */
  reference: FileMap;
  /** Relative paths that must exist after the run (checked before the command). */
  requireFiles?: string[];
  /** Patterns that must be absent from a file after the run. */
  forbidPatterns?: ForbidPattern[];
  /** Expected process exit code for `testCommand` (default 0). */
  expectExit?: number;
  /** Wall-clock budget for the hidden test command. */
  timeoutSec?: number;
  /** Step budget for the agent (agent mode only). */
  maxSteps?: number;
  tags?: string[];
}

/** One named check performed while grading a task. */
export interface GradeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TaskResult {
  id: string;
  title: string;
  category: TaskCategory;
  language: TaskLanguage;
  status: TaskStatus;
  /** 1 for a pass, 0 otherwise. */
  score: number;
  durationMs: number;
  steps?: number;
  model?: string;
  exitCode?: number;
  timedOut?: boolean;
  error?: string;
  checks: GradeCheck[];
  /** Tail of the hidden-test command output. */
  testOutput?: string;
}

/** `self-check` applies the reference solution and expects a pass;
 *  `baseline` runs the untouched tree and expects the hidden test to fail
 *  (proving the fixture is meaningful); `agent` runs the real coding agent. */
export type EvalMode = "agent" | "self-check" | "baseline";

export interface CodingRunReport {
  id: string;
  mode: EvalMode;
  startedAt: string;
  finishedAt: string;
  model: string;
  /** pass@1 = passed / (total - skipped). */
  passAt1: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  /** Wall-clock duration of the whole run. */
  durationMs: number;
  results: TaskResult[];
}

export interface RunCodingEvalOptions {
  mode: EvalMode;
  model?: string;
  /** Only run these task ids (default: every task). */
  only?: string[];
  /** Base directory for generated sandboxes (default: evals/coding/results). */
  workDir?: string;
  /** Wall-clock budget for the agent per task, in milliseconds. */
  agentTimeoutMs?: number;
  /** Step budget for the agent per task (overrides the task's own maxSteps). */
  maxSteps?: number;
  /** Skip the terminal assistant/done events (faster, more deterministic). */
  suppressFinal?: boolean;
  signal?: AbortSignal;
  onTask?: (result: TaskResult) => void;
}
