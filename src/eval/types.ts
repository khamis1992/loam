import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";

export type VerifierSpec =
  | { type: "file_exists"; path: string }
  | { type: "file_absent"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_matches"; path: string; pattern: string; flags?: string }
  | { type: "shell_exit"; command: string; exitCode?: number }
  | { type: "shell_contains"; command: string; text: string }
  | { type: "http_ok"; url: string; jsonPath?: string }
  | { type: "tool_used"; name: string; expectOk?: boolean; minCount?: number }
  | { type: "answer_matches"; pattern: string; flags?: string }
  | { type: "llm_judge"; rubric: string };

export interface EvalCaseSetup {
  type: "write_file";
  path: string;
  text: string;
}

export interface EvalCase {
  id: string;
  prompt: string;
  setup?: EvalCaseSetup[];
  verify?: VerifierSpec[];
  budget?: { maxSteps?: number; timeoutSec?: number };
  tags?: string[];
  network?: boolean;
}

export interface EvalSuite {
  id: string;
  name: string;
  version: number;
  cases: EvalCase[];
}

export interface Checkpoint {
  type: string;
  ok: boolean;
  detail: string;
}

export interface CritiqueResult {
  passed: boolean;
  score: number;
  reasons: string[];
  failureCauses: string[];
  betterPlan: string;
  lessons: string[];
}

export type CaseStatus = "pass" | "fail" | "error" | "skipped";

export interface CaseResult {
  id: string;
  prompt: string;
  status: CaseStatus;
  score: number;
  steps: number;
  durationMs: number;
  error?: string;
  usage: { promptTokens: number; completionTokens: number };
  checkpoints: Checkpoint[];
  finalText: string;
  critique?: CritiqueResult | null;
}

export interface EvalRunSummary {
  id: string;
  suiteId: string;
  suiteName: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  status?: "running";
  summary: {
    pass: number;
    fail: number;
    error: number;
    skipped: number;
    passRate: number;
    cases: number;
  };
}

export interface EvalRun extends EvalRunSummary {
  cases: CaseResult[];
}

export interface TelemetryRecord {
  at: string;
  kind: "task" | "eval-case";
  taskId?: string;
  runId?: string;
  caseId?: string;
  model: string;
  status: "done" | "error" | "stopped";
  steps: number;
  durationMs: number;
  usage: { promptTokens: number; completionTokens: number };
  toolCalls: Array<{ name: string; ok: boolean; ms?: number }>;
  promptHash: string;
  promptChars: number;
  passed?: boolean;
  score?: number;
  error?: string;
}

export interface VerifyContext {
  workspace: string;
  finalText: string;
  trace: Array<{ name: string; ok: boolean; ms?: number }>;
  cfg: Config;
  ollama?: OllamaClient;
}
