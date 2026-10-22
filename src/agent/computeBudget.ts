/**
 * Per-session compute budget (D19): a hard ceiling on how much work one
 * session may consume, in steps and in tokens.
 *
 * The budget exists so a runaway loop cannot silently burn an unbounded amount
 * of compute. It warns the user at 80% (they can still act) and stops the run
 * at 100%; the user may raise the ceiling and the run resumes.
 *
 * All functions are pure so the deterministic gate can exercise them with fake
 * timers and synthetic usage counters — no model calls, no external APIs.
 */

export type BudgetLimitKind = "steps" | "tokens";

/** Budget counters for a single session. */
export interface ComputeBudget {
  /** Completed agent steps (one model round-trip). */
  steps: number;
  promptTokens: number;
  completionTokens: number;
  /** Ceiling applied to this session; undefined = inherit the global default. */
  stepLimit?: number;
  tokenLimit?: number;
  /** true once the user raised the ceiling after a stop. */
  raised?: boolean;
}

/** Verdict of a consumption attempt against the budget. */
export type BudgetDecision =
  | { action: "allow" }
  | { action: "warn"; reason: string }
  | { action: "stop"; reason: string };

export const WARN_RATIO = 0.8;

export interface ComputeBudgetLimits {
  stepLimit?: number;
  tokenLimit?: number;
}

/** A positive, finite limit; anything else is ignored (budget stays unlimited). */
export function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

/** Build a fresh budget, clamping the limits to positive finite numbers. */
export function createComputeBudget(limits: ComputeBudgetLimits = {}): ComputeBudget {
  return {
    steps: 0,
    promptTokens: 0,
    completionTokens: 0,
    stepLimit: normalizeLimit(limits.stepLimit),
    tokenLimit: normalizeLimit(limits.tokenLimit),
  };
}

export function totalTokens(budget: ComputeBudget): number {
  return budget.promptTokens + budget.completionTokens;
}

/** Consume one completed step. Returns the new step count. */
export function consumeSteps(budget: ComputeBudget, steps = 1): number {
  if (!Number.isFinite(steps) || steps < 0) return budget.steps;
  budget.steps = Math.floor(budget.steps + steps);
  return budget.steps;
}

/** Consume model usage (prompt + completion tokens). */
export function consumeTokens(budget: ComputeBudget, prompt = 0, completion = 0): void {
  const p = Number.isFinite(prompt) && prompt > 0 ? Math.floor(prompt) : 0;
  const c = Number.isFinite(completion) && completion > 0 ? Math.floor(completion) : 0;
  budget.promptTokens += p;
  budget.completionTokens += c;
}

/**
 * Decide whether the session may continue. Called BEFORE a step runs and
 * BEFORE the next tool call: the first crossing of 100% stops the run rather
 * than letting it burn one more step.
 *
 * Order matters: a stop verdict always wins over a warn verdict so the hard
 * ceiling is never reported as "only a warning".
 */
export function checkBudget(budget: ComputeBudget, limits: ComputeBudgetLimits = {}): BudgetDecision {
  const stepLimit = budget.stepLimit ?? normalizeLimit(limits.stepLimit);
  const tokenLimit = budget.tokenLimit ?? normalizeLimit(limits.tokenLimit);

  if (stepLimit !== undefined && budget.steps >= stepLimit) {
    return {
      action: "stop",
      reason: `Compute budget exhausted: ${budget.steps}/${stepLimit} steps. Raise the session budget to continue.`,
    };
  }
  if (tokenLimit !== undefined && totalTokens(budget) >= tokenLimit) {
    return {
      action: "stop",
      reason: `Compute budget exhausted: ${totalTokens(budget)}/${tokenLimit} tokens. Raise the session budget to continue.`,
    };
  }

  const steps = stepLimit !== undefined ? budget.steps / stepLimit : 0;
  const tokens = tokenLimit !== undefined ? totalTokens(budget) / tokenLimit : 0;
  const ratio = Math.max(steps, tokens);
  if (ratio >= WARN_RATIO) {
    return { action: "warn", reason: `Compute budget ${Math.round(ratio * 100)}% used` };
  }
  return { action: "allow" };
}

/** Human-readable usage line for the UI badge / API payload. */
export function formatBudgetUsage(budget: ComputeBudget): string {
  const steps = budget.stepLimit !== undefined ? `${budget.steps}/${budget.stepLimit}` : `${budget.steps}`;
  const tokens = budget.tokenLimit !== undefined ? `${totalTokens(budget)}/${budget.tokenLimit}` : `${totalTokens(budget)}`;
  return `steps ${steps} · tokens ${tokens}`;
}

/**
 * Raise the ceiling. A raise of 0 (or a smaller value) is refused so a user
 * cannot lock the session out of continuing.
 */
export function raiseBudget(
  budget: ComputeBudget,
  delta: { steps?: number; tokens?: number },
): { ok: boolean; reason?: string } {
  const stepDelta = normalizeLimit(delta.steps) ?? 0;
  const tokenDelta = normalizeLimit(delta.tokens) ?? 0;
  if (stepDelta === 0 && tokenDelta === 0) {
    return { ok: false, reason: "budget increase must be a positive number" };
  }
  if (stepDelta > 0) {
    budget.stepLimit = (budget.stepLimit ?? budget.steps) + stepDelta;
  }
  if (tokenDelta > 0) {
    budget.tokenLimit = (budget.tokenLimit ?? totalTokens(budget)) + tokenDelta;
  }
  budget.raised = true;
  return { ok: true };
}

/** Reset counters while keeping the (possibly raised) ceiling — used on resume. */
export function resetBudgetUsage(budget: ComputeBudget): void {
  budget.steps = 0;
  budget.promptTokens = 0;
  budget.completionTokens = 0;
}

/** Test helper: a budget with generous limits, so a test controls its own numbers. */
export function createUnlimitedBudget(): ComputeBudget {
  return { steps: 0, promptTokens: 0, completionTokens: 0 };
}
