/**
 * Neo long-horizon eval gate: fixture, run and score types (N20).
 *
 * The Neo programme promises "long-horizon Recipe/Mission runs": an agent that
 * keeps working across many rounds, cites what it used, keeps its token spend
 * flat instead of ballooning, and recovers when a tool or a process dies. None
 * of that is observable in a single-turn coding fixture, which is why this gate
 * exists next to the C18 (coding) and V1 (design) suites.
 *
 * Ten fixture tasks drive a scripted mock model through the real agent loop and
 * tool registry, so every case exercises the production path (system prompt,
 * tool dispatch, stall guard, step budget, checkpoint resume, final
 * verification) while staying fully offline and deterministic.
 *
 * Per case the gate scores four dimensions, matching the N20 contract:
 *   completion (0.4) — did the agent finish the observable artifact?
 *   citation   (0.2) — did the answer cite the knowledge seeds it used?
 *   flatness   (0.2) — did the prompt stay bounded across a long run?
 *   recovery   (0.2) — did a failing tool get retried or worked around?
 *
 * A dimension that a fixture does not exercise is reported as `null` and left
 * out of the weighted total, so a short fixture is not punished for a behaviour
 * it never had a chance to show.
 */
import type { ScheduleTiming } from "../server/scheduleTime.js";

/** Dimension weights for the overall case score. */
export const NEO_WEIGHTS = {
  completion: 0.4,
  citation: 0.2,
  flatness: 0.2,
  recovery: 0.2,
} as const;

/** A case is a pass when `total >= NEO_PASS_BAR`. */
export const NEO_PASS_BAR = 60;

/** Bump when the fixture contract, scorer or script shape changes. */
/**
 * `neo-eval-2`: the flatness band and the recurring append check were corrected,
 * so scores recorded under `neo-eval-1` are not comparable to this version.
 */
export const NEO_HARNESS_VERSION = "neo-eval-2";

/** A dimension the fixture exercised, with its score and the evidence behind it. */
export interface NeoDimensionScore {
  name: "completion" | "citation" | "flatness" | "recovery" | "recurring";
  /** 0..100 */
  score: number;
  /** Short human-readable reason, recorded in the baseline. */
  detail: string;
}

export interface NeoTraceItem {
  name: string;
  ok: boolean;
  summary: string;
  /** Tool arguments, so the trace can be inspected without the live run. */
  args?: unknown;
}

export interface NeoCheckResult {
  kind: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** Everything the scorer needs to judge one fixture run. */
export interface NeoCaseArtifacts {
  /** Workspace-relative path -> content, for the files the fixture captures. */
  files: Record<string, string>;
  /** Final user-facing answer (empty when the run never finished). */
  finalText: string;
  /** Every tool call, in order, with its outcome. */
  trace: NeoTraceItem[];
  /** Estimated prompt tokens charged at each agent step, in order. */
  promptTokensPerStep: number[];
  /** True when the loop hit its step budget without finishing. */
  budgetExhausted: boolean;
  /** Deterministic outcome of each assertion the fixture declares. */
  checks: NeoCheckResult[];
  /** Knowledge seeds the answer cited, in citation order. */
  citedSeedIds: string[];
  /** Rounds of recurring work that actually ran. */
  rounds: number;
  /** The mock clock at the end of the run. */
  clockIso: string;
  /**
   * True when a run was stopped at the fixture's interrupt point and then
   * resumed from the checkpoint the loop saved before that call.
   */
  resumedFrom: boolean;
}

/** One dimension and its evidence, recorded per case. */
export interface NeoCaseScore {
  id: string;
  dimension: NeoFixture["dimension"];
  completion: number | null;
  citation: number | null;
  flatness: number | null;
  recovery: number | null;
  recurring: number | null;
  total: number;
  verdict: "pass" | "fail";
  dimensions: NeoDimensionScore[];
  checks: NeoCheckResult[];
  steps: number;
  finalText: string;
  durationMs: number;
}

/** A knowledge seed the mock `kb_search` tool returns and the scorer checks for. */
export interface NeoSeed {
  id: string;
  title: string;
  body: string;
  tags?: string[];
}

/**
 * Assertions the fixture author declares for the completion dimension.
 *
 * The discriminated union keeps each kind's fields required, so a fixture cannot
 * declare a `count_min` without a tool name or a `file_matches` without a path.
 */
export type NeoAssertSpec =
  | { kind: "file_exists"; path: string }
  | { kind: "resumed" }
  | { kind: "file_matches"; path: string; value: string }
  | { kind: "answer_matches"; value: string }
  | { kind: "trace_used"; tool: string }
  | { kind: "trace_not_used"; tool: string }
  | { kind: "count_min"; tool: string; count: number };

/** The run state a scripted turn or fault hook can observe. */
export interface NeoScriptRuntime {
  /** Current agent step (1-based once the first step has run). */
  atStep: number;
  /** Number of tool calls dispatched so far. */
  calls: number;
  /** Whether a workspace-relative (or absolute) path exists on disk. */
  fileExists: (path: string) => boolean;
}

/** One scripted model turn. */
export interface NeoScriptStep {
  /** Assistant text emitted with this turn. */
  text?: string;
  /** Tool calls made in this turn, executed in order. */
  calls?: Array<{ tool: string; args?: Record<string, unknown> }>;
  /**
   * Grounded `finalAnswer` attached to a verifier turn's JSON verdict.
   *
   * The production verifier only sets `VerdictOutcome.finalAnswer` when its
   * JSON carries a non-empty `finalAnswer`; prose alone is never delivered as
   * the user-visible answer. A fixture's script is plain text and cannot emit
   * that field, so the harness supplies it from the workspace. The template
   * `{REPORT}` is replaced with the fixture's first capture path, so a case
   * names its artifact without a second copy of the filename.
   */
  finalAnswerFromToolResult?: string;
  /** Only emit this turn when the guard matches; otherwise the script advances. */
  when?: {
    /** A tool with this name must have been called already. */
    afterCall?: string;
    /** A call of this tool must have failed already. */
    afterFail?: string;
    /** At least this many tool calls must have been dispatched. */
    minCalls?: number;
    /** Restrict the match to the last N turns, inclusive (1 = the last turn). */
    within?: number;
  };
  /** Prompt-token override for this turn (defaults to the real message length). */
  promptTokens?: number;
}

/**
 * Mock-model configuration: the scripted turns plus fault injection.
 *
 * Faults are expressed as an `onCall` hook rather than a named string: the hook
 * receives the tool name, its arguments and the run's {@link NeoScriptRuntime},
 * so a fixture can fail a call once, twice, or until a file exists, without the
 * harness having to grow a fault grammar of its own.
 */
export interface NeoModelScript {
  steps: NeoScriptStep[];
  /**
   * Fault injection hook. Return a message to fail the call, or undefined to let
   * it through. Called before the real tool runs.
   */
  onCall?: (tool: string, args: Record<string, unknown>, runtime: NeoScriptRuntime) => string | undefined;
}

/** Per-case patch on top of the default eval config. */
export interface NeoConfigPatch {
  model?: string;
  /** Extra characters appended to every step's prompt, to model a growing doc. */
  growthPerStep?: number;
}

/** One fixture task (10 total). */
export interface NeoFixture {
  id: string;
  name: string;
  dimension: "completion" | "citation" | "flatness" | "recovery" | "recurring";
  prompt: string;
  /** Replaces the assembled master prompt with a small, bounded one. */
  system?: string;
  /** Step budget for this case (default 40). */
  maxSteps?: number;
  /** Tool names to register (default: the file tools plus `kb_search`). */
  tools?: string[];
  /** Files written into the case workspace before the run. */
  seedFiles?: Array<{ path: string; text: string }>;
  /** Knowledge seeds available to the run. */
  seeds?: NeoSeed[];
  script: NeoModelScript;
  /** Script the loop's own verifier replays (defaults to inspect then pass). */
  verifierScript?: NeoModelScript;
  asserts?: NeoAssertSpec[];
  /** Workspace-relative files to read back after the run. */
  capture?: string[];
  config?: NeoConfigPatch;
  /** Recurring dimension: each round is a fresh run at the given instant. */
  schedule?: ScheduleTiming;
  /** Recurring dimension: one fresh agent run per round, at the given instant. */
  rounds?: NeoRound[];
  /**
   * Restart-from-step: the harness stops the run after this many dispatched
   * tool calls and resumes it from the checkpoint the loop saved before that
   * call. The resume is a fresh run carrying the saved transcript, which is what
   * makes this measure recovery across a restart rather than a single long
   * transcript.
   */
  interruptAfter?: number;
}

/** One round of a recurring fixture. */
export interface NeoRound {
  /** Virtual-clock instant the round starts at (ISO 8601). */
  at: string;
  name: string;
  /** Round-specific instruction; defaults to the fixture prompt. */
  prompt?: string;
}

/** A single model run: the artifact plus the evidence the scorer needs. */
export interface NeoRunResult {
  finalText: string;
  trace: NeoTraceItem[];
  promptTokens: number[];
  systemChars: number;
  steps: number;
  /** Rounds of recurring work that actually completed. */
  rounds: number;
  /** Tool calls issued after a resume (restart-from-step). */
  callsAfterResume: number;
  resumedFrom: boolean;
  budgetExhausted: boolean;
  checks: NeoCheckResult[];
  files: Record<string, string>;
  /** Knowledge seeds the final answer cited, in citation order. */
  citedSeedIds: string[];
  clockIso: string;
  durationMs: number;
}

export interface NeoSuiteResult {
  version: string;
  passBar: number;
  cases: NeoCaseScore[];
  total: number;
  passed: number;
  failed: number;
  verdict: "pass" | "fail";
}

/** Recorded baseline: a version-pinned copy of the suite result. */
export interface NeoBaseline {
  version: string;
  passBar: number;
  total: number;
  passed: number;
  failed: number;
  cases: Array<{
    id: string;
    total: number;
    verdict: "pass" | "fail";
    completion: number | null;
    citation: number | null;
    flatness: number | null;
    recovery: number | null;
    recurring: number | null;
    steps: number;
    dimensions: Array<{ name: string; score: number; detail: string }>;
  }>;
}
