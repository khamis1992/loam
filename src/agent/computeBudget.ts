/**
 * Per-session compute budget (D19): a hard ceiling on how much work one
 * session may consume, in steps and in tokens.
 *
 * Neo N6 extends the same budget object with two more dimensions a long-horizon
 * mission actually needs: elapsed wall-clock time and estimated USD cost. They
 * are pure counters and pure predicates, so a deterministic gate can exercise
 * them with fake timers and synthetic usage — no model calls, no external APIs.
 *
 * The budget exists so a runaway loop cannot silently burn an unbounded amount
 * of compute. It warns the user at 80% (they can still act) and stops the run
 * at 100%; the user may raise the ceiling and the run resumes.
 */

export type BudgetLimitKind = "steps" | "tokens";

/** Budget counters for a single session. */
export interface ComputeBudget {
  /** Completed agent steps (one model round-trip). */
  steps: number;
  promptTokens: number;
  completionTokens: number;
  /** Neo N6: elapsed wall-clock milliseconds charged to this mission. */
  wallClockMs?: number;
  /** Neo N6: estimated USD cost charged to this mission. */
  costUsd?: number;
  /** Ceiling applied to this session; undefined = inherit the global default. */
  stepLimit?: number;
  tokenLimit?: number;
  /** Neo N6: wall-clock ceiling in milliseconds. */
  wallClockLimitMs?: number;
  /** Neo N6: cost ceiling in USD. */
  costLimitUsd?: number;
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
  /** Neo N6: wall-clock ceiling in milliseconds. */
  wallClockMs?: number;
  /** Neo N6: cost ceiling in USD. */
  costUsd?: number;
}

/**
 * A positive, finite limit; anything else is ignored (budget stays unlimited).
 *
 * Values are kept as-is (not floored) because a limit is not always a count of
 * whole units: a mission's cost ceiling is USD, and `$0.01` is a real ceiling
 * that flooring to `0` would discard. Callers that need an integer (steps,
 * tokens) compare against `Math.floor`-ed counters.
 */
export function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 0 ? value : undefined;
}

/** Build a fresh budget, clamping the limits to positive finite numbers. */
export function createComputeBudget(limits: ComputeBudgetLimits = {}): ComputeBudget {
  return {
    steps: 0,
    promptTokens: 0,
    completionTokens: 0,
    wallClockMs: 0,
    costUsd: 0,
    stepLimit: normalizeLimit(limits.stepLimit),
    tokenLimit: normalizeLimit(limits.tokenLimit),
    wallClockLimitMs: normalizeLimit(limits.wallClockMs),
    costLimitUsd: normalizeLimit(limits.costUsd),
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

/** Consume elapsed wall-clock time (Neo N6). */
export function consumeWallClock(budget: ComputeBudget, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  budget.wallClockMs = (budget.wallClockMs ?? 0) + Math.floor(ms);
}

/** Consume estimated USD cost (Neo N6). Unknown or local models cost 0. */
export function consumeCost(budget: ComputeBudget, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  budget.costUsd = (budget.costUsd ?? 0) + usd;
}

/** Elapsed wall-clock milliseconds charged so far. */
export function wallClockUsed(budget: ComputeBudget): number {
  return budget.wallClockMs ?? 0;
}

/** Estimated USD cost charged so far. */
export function costUsed(budget: ComputeBudget): number {
  return budget.costUsd ?? 0;
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
  const wallClockLimit = budget.wallClockLimitMs ?? normalizeLimit(limits.wallClockMs);
  const costLimit = budget.costLimitUsd ?? normalizeLimit(limits.costUsd);

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
  const clock = wallClockUsed(budget);
  if (wallClockLimit !== undefined && clock >= wallClockLimit) {
    return {
      action: "stop",
      reason: `Compute budget exhausted: ${formatDuration(clock)} of ${formatDuration(wallClockLimit)} wall-clock. Raise the session budget to continue.`,
    };
  }
  const spend = costUsed(budget);
  if (costLimit !== undefined && spend >= costLimit) {
    return {
      action: "stop",
      reason: `Compute budget exhausted: $${spend.toFixed(4)} of $${costLimit.toFixed(4)}. Raise the session budget to continue.`,
    };
  }

  const steps = stepLimit !== undefined ? budget.steps / stepLimit : 0;
  const tokens = tokenLimit !== undefined ? totalTokens(budget) / tokenLimit : 0;
  const elapsed = wallClockLimit !== undefined ? clock / wallClockLimit : 0;
  const costRatio = costLimit !== undefined ? spend / costLimit : 0;
  const ratio = Math.max(steps, tokens, elapsed, costRatio);
  if (ratio >= WARN_RATIO) {
    return { action: "warn", reason: `Compute budget ${Math.round(ratio * 100)}% used` };
  }
  return { action: "allow" };
}

/** `45m` / `90s`: a ceiling a human can read at a glance. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.round((total % 60_000) / 1000);
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
}

/** Human-readable usage line for the UI badge / API payload. */
export function formatBudgetUsage(budget: ComputeBudget): string {
  const steps = budget.stepLimit !== undefined ? `${budget.steps}/${budget.stepLimit}` : `${budget.steps}`;
  const tokens = budget.tokenLimit !== undefined ? `${totalTokens(budget)}/${budget.tokenLimit}` : `${totalTokens(budget)}`;
  const parts = [`steps ${steps}`, `tokens ${tokens}`];
  if (budget.wallClockLimitMs !== undefined) {
    parts.push(`clock ${formatDuration(wallClockUsed(budget))}/${formatDuration(budget.wallClockLimitMs)}`);
  }
  if (budget.costLimitUsd !== undefined) {
    parts.push(`cost $${costUsed(budget).toFixed(4)}/$${budget.costLimitUsd.toFixed(4)}`);
  }
  return parts.join(" · ");
}

/**
 * Raise the ceiling. A raise of 0 (or a smaller value) is refused so a user
 * cannot lock the session out of continuing.
 */
export function raiseBudget(
  budget: ComputeBudget,
  delta: { steps?: number; tokens?: number; wallClockMs?: number; costUsd?: number },
): { ok: boolean; reason?: string } {
  const stepDelta = normalizeLimit(delta.steps) ?? 0;
  const tokenDelta = normalizeLimit(delta.tokens) ?? 0;
  const clockDelta = normalizeLimit(delta.wallClockMs) ?? 0;
  const costDelta = normalizeLimit(delta.costUsd) ?? 0;
  if (stepDelta === 0 && tokenDelta === 0 && clockDelta === 0 && costDelta === 0) {
    return { ok: false, reason: "budget increase must be a positive number" };
  }
  if (stepDelta > 0) {
    budget.stepLimit = (budget.stepLimit ?? budget.steps) + stepDelta;
  }
  if (tokenDelta > 0) {
    budget.tokenLimit = (budget.tokenLimit ?? totalTokens(budget)) + tokenDelta;
  }
  if (clockDelta > 0) {
    budget.wallClockLimitMs = (budget.wallClockLimitMs ?? wallClockUsed(budget)) + clockDelta;
  }
  if (costDelta > 0) {
    budget.costLimitUsd = (budget.costLimitUsd ?? costUsed(budget)) + costDelta;
  }
  budget.raised = true;
  return { ok: true };
}

/** Reset counters while keeping the (possibly raised) ceiling — used on resume. */
export function resetBudgetUsage(budget: ComputeBudget): void {
  budget.steps = 0;
  budget.promptTokens = 0;
  budget.completionTokens = 0;
  budget.wallClockMs = 0;
  budget.costUsd = 0;
}

/** Test helper: a budget with generous limits, so a test controls its own numbers. */
export function createUnlimitedBudget(): ComputeBudget {
  return { steps: 0, promptTokens: 0, completionTokens: 0, wallClockMs: 0, costUsd: 0 };
}
