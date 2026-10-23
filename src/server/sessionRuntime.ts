/**
 * Per-session runtime state store (D19): the single place that owns, for one
 * session, both the compute budget and the sleep lifecycle. Keeping them in one
 * module is deliberate — waking a session must also confirm the budget still
 * allows work, and sleeping must not lose budget counters.
 *
 * Nothing here touches the network: hooks are injected, so the deterministic
 * gate can assert the exact lifecycle. `src/index.ts` wires the real hooks
 * (browser session close, pty kill) into this store.
 */

import {
  SessionSleepManager,
  type SleepHooks,
  type SleepSnapshot,
  type SleepManagerOptions,
} from "./sessionSleep.js";
import {
  checkBudget,
  consumeCost,
  consumeWallClock,
  consumeSteps,
  consumeTokens,
  createComputeBudget,
  raiseBudget,
  resetBudgetUsage,
  totalTokens,
  type ComputeBudget,
  type ComputeBudgetLimits,
} from "../agent/computeBudget.js";
import { log } from "../log.js";

/** Server-side defaults; the UI can read them to render the badge. */
export const DEFAULT_IDLE_MINUTES = 30;
/** Step ceiling when the config does not override it (mirrors cfg.agent.maxSteps). */
export const DEFAULT_STEP_LIMIT = 40;
/** Token ceiling when the config does not override it. */
export const DEFAULT_TOKEN_LIMIT = 500_000;

export interface SessionRuntimeOptions {
  idleMinutes?: number;
  stepLimit?: number;
  tokenLimit?: number;
  /** Neo N6: default wall-clock ceiling in minutes (0/undefined = no ceiling). */
  wallClockMinutes?: number;
  /** Neo N6: default cost ceiling in USD. */
  costLimitUsd?: number;
  now?: () => number;
  hooks?: Partial<Record<string, SleepHooks>>;
}

/** Per-session runtime entry: budget counters plus sleep bookkeeping. */
interface RuntimeEntry {
  budget: ComputeBudget;
  /** Set once a run stopped on the budget ceiling, cleared by a raise. */
  stoppedOnBudget?: boolean;
  /** Set when the session is put to sleep; cleared on wake. */
  sleepSnapshot?: SleepSnapshot;
  /** Last budget warning, so the UI can show it without re-deriving. */
  lastWarning?: string;
}

export class SessionRuntime {
  readonly sleep: SessionSleepManager;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly stepLimit?: number;
  private readonly tokenLimit?: number;
  private readonly wallClockLimitMs?: number;
  private readonly costLimitUsd?: number;

  constructor(options: SessionRuntimeOptions = {}) {
    this.stepLimit = options.stepLimit;
    this.tokenLimit = options.tokenLimit;
    this.wallClockLimitMs = options.wallClockMinutes && options.wallClockMinutes > 0
      ? Math.floor(options.wallClockMinutes * 60_000)
      : undefined;
    this.costLimitUsd = options.costLimitUsd && options.costLimitUsd > 0 ? options.costLimitUsd : undefined;
    this.sleep = new SessionSleepManager({
      idleMinutes: options.idleMinutes,
      now: options.now,
      hooks: options.hooks,
      onStateChange: (record, reason) => {
        const entry = this.entries.get(record.sessionId);
        if (!entry) return;
        if (record.state === "sleeping") entry.sleepSnapshot = record.snapshot;
        if (record.state === "active" || record.state === "awake") entry.sleepSnapshot = undefined;
        log.info(`session ${record.sessionId} -> ${record.state} (${reason})`);
      },
    });
  }

  private ensure(sessionId: string): RuntimeEntry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = {
        budget: createComputeBudget({
          stepLimit: this.stepLimit,
          tokenLimit: this.tokenLimit,
          wallClockMs: this.wallClockLimitMs,
          costUsd: this.costLimitUsd,
        }),
      };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  /* ------------------------------ budget ------------------------------ */

  getBudget(sessionId: string): ComputeBudget {
    return this.ensure(sessionId).budget;
  }

  /**
   * Neo N6: adopt a mission budget for this session. A mission carries its own
   * ceilings (and the counters carried over from its checkpoint) instead of the
   * ordinary session defaults, so the badge and the run agree on the ceiling.
   */
  adoptBudget(sessionId: string, budget: ComputeBudget): void {
    this.entries.set(sessionId, { budget });
  }

  /**
   * Neo N6: the mission budget is mutated by the run itself (wall-clock and cost
   * are charged inside the loop, not through this store). Hand the same object
   * back to the store so the badge and the raise endpoint keep seeing the
   * mission's real counters after the run ends.
   */
  adoptBudgetAfterRun(sessionId: string, budget: ComputeBudget): void {
    const entry = this.ensure(sessionId);
    entry.budget = budget;
    entry.stoppedOnBudget = checkBudget(budget).action === "stop";
  }

  /** Consume one completed step and return the verdict for the NEXT step. */
  recordStep(sessionId: string): ReturnType<typeof checkBudget> {
    const entry = this.ensure(sessionId);
    consumeSteps(entry.budget, 1);
    return this.evaluate(sessionId);
  }

  /** Consume model usage and return the verdict for the next step. */
  recordUsage(sessionId: string, prompt: number, completion: number): ReturnType<typeof checkBudget> {
    const entry = this.ensure(sessionId);
    consumeTokens(entry.budget, prompt, completion);
    return this.evaluate(sessionId);
  }

  /** Neo N6: consume elapsed wall-clock time and return the next verdict. */
  recordWallClock(sessionId: string, ms: number): ReturnType<typeof checkBudget> {
    const entry = this.ensure(sessionId);
    consumeWallClock(entry.budget, ms);
    return this.evaluate(sessionId);
  }

  /** Neo N6: consume estimated USD cost and return the next verdict. */
  recordCost(sessionId: string, usd: number): ReturnType<typeof checkBudget> {
    const entry = this.ensure(sessionId);
    consumeCost(entry.budget, usd);
    return this.evaluate(sessionId);
  }

  /** Evaluate the budget and remember the warning/stop reason. */
  evaluate(sessionId: string): ReturnType<typeof checkBudget> {
    const entry = this.ensure(sessionId);
    const decision = checkBudget(entry.budget, {
      stepLimit: this.stepLimit,
      tokenLimit: this.tokenLimit,
      wallClockMs: this.wallClockLimitMs,
      costUsd: this.costLimitUsd,
    });
    if (decision.action === "stop") entry.stoppedOnBudget = true;
    if (decision.action === "warn") entry.lastWarning = decision.reason;
    return decision;
  }

  isStoppedOnBudget(sessionId: string): boolean {
    return this.entries.get(sessionId)?.stoppedOnBudget ?? false;
  }

  lastWarning(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.lastWarning;
  }

  /**
   * Raise the ceiling. The counters are NOT reset: work already done still
   * counts, so a raise can only ever allow more, never erase usage.
   */
  raise(sessionId: string, delta: { steps?: number; tokens?: number; wallClockMs?: number; costUsd?: number }): { ok: boolean; reason?: string; budget: ComputeBudget } {
    const entry = this.ensure(sessionId);
    const result = raiseBudget(entry.budget, delta);
    if (result.ok) {
      entry.stoppedOnBudget = false;
      entry.lastWarning = undefined;
    }
    return { ...result, budget: entry.budget };
  }

  /** Resume after a budget stop: clears the stop flag, keeps the raised ceiling. */
  resumeAfterRaise(sessionId: string): void {
    const entry = this.ensure(sessionId);
    entry.stoppedOnBudget = false;
  }

  /* ------------------------------- sleep ------------------------------ */
  markActive(sessionId: string): void {
    void this.sleep.markActive(sessionId);
  }

  markIdle(sessionId: string): void {
    this.sleep.markIdle(sessionId);
  }

  /** Force the session to sleep (releases resources after persisting). */
  async forceSleep(sessionId: string, reason?: string): Promise<void> {
    await this.sleep.sleep(sessionId, reason ?? "manual");
  }

  /** Force the session awake (restores released resources). */
  async forceWake(sessionId: string, reason?: string): Promise<void> {
    await this.sleep.wake(sessionId, reason ?? "manual");
  }

  /** A user message wakes the session; if the budget is still exhausted, the
   *  caller must refuse the run and ask for a raise. */
  async onUserMessage(sessionId: string): Promise<{ slept: boolean; state: string }> {
    const slept = this.sleep.isSleeping(sessionId);
    const record = await this.sleep.onUserMessage(sessionId);
    return { slept, state: record.state };
  }

  getSleepState(sessionId: string): string {
    return this.sleep.getState(sessionId);
  }

  sleepSnapshot(sessionId: string): SleepSnapshot | undefined {
    return this.entries.get(sessionId)?.sleepSnapshot ?? this.sleep.getRecord(sessionId)?.snapshot;
  }

  msUntilSleep(sessionId: string): number | undefined {
    return this.sleep.msUntilSleep(sessionId);
  }

  /** Serialized state for the API badge payload. */
  snapshot(sessionId: string): {
    sessionId: string;
    state: string;
    budget: {
      steps: number;
      stepLimit?: number;
      tokens: number;
      tokenLimit?: number;
      wallClockMs?: number;
      wallClockLimitMs?: number;
      costUsd?: number;
      costLimitUsd?: number;
      percent: number;
      warning?: string;
      stopped: boolean;
    };
    sleeping: boolean;
    msUntilSleep?: number;
    raised: boolean;
  } {
    const entry = this.ensure(sessionId);
    const budget = entry.budget;
    const stepPct = budget.stepLimit ? budget.steps / budget.stepLimit : 0;
    const tokenPct = budget.tokenLimit ? totalTokens(budget) / budget.tokenLimit : 0;
    const clockPct = budget.wallClockLimitMs ? (budget.wallClockMs ?? 0) / budget.wallClockLimitMs : 0;
    const costPct = budget.costLimitUsd ? (budget.costUsd ?? 0) / budget.costLimitUsd : 0;
    return {
      sessionId,
      state: this.sleep.getState(sessionId),
      budget: {
        steps: budget.steps,
        ...(budget.stepLimit !== undefined ? { stepLimit: budget.stepLimit } : {}),
        tokens: totalTokens(budget),
        ...(budget.tokenLimit !== undefined ? { tokenLimit: budget.tokenLimit } : {}),
        ...(budget.wallClockMs !== undefined ? { wallClockMs: budget.wallClockMs } : {}),
        ...(budget.wallClockLimitMs !== undefined ? { wallClockLimitMs: budget.wallClockLimitMs } : {}),
        ...(budget.costUsd !== undefined ? { costUsd: budget.costUsd } : {}),
        ...(budget.costLimitUsd !== undefined ? { costLimitUsd: budget.costLimitUsd } : {}),
        percent: Math.round(Math.max(stepPct, tokenPct, clockPct, costPct) * 100),
        ...(entry.lastWarning ? { warning: entry.lastWarning } : {}),
        stopped: entry.stoppedOnBudget ?? false,
      },
      sleeping: this.sleep.isSleeping(sessionId),
      ...(this.sleep.msUntilSleep(sessionId) !== undefined ? { msUntilSleep: this.sleep.msUntilSleep(sessionId) } : {}),
      raised: budget.raised ?? false,
    };
  }

  forget(sessionId: string): void {
    this.sleep.forget(sessionId);
    this.entries.delete(sessionId);
  }

  /** Register the resource hooks (browser/pty release) for one session. */
  setHooks(sessionId: string, hooks: SleepHooks): void {
    this.sleep.setHooks(sessionId, hooks);
  }

  resetBudgetUsage(sessionId: string): void {
    resetBudgetUsage(this.ensure(sessionId).budget);
  }

  start(intervalMs?: number): void {
    this.sleep.start(intervalMs);
  }

  stop(): void {
    this.sleep.stop();
  }

  close(): void {
    this.sleep.close();
  }
}

/** Process-wide runtime used by the server routes. */
export const sessionRuntime = new SessionRuntime();

export type { ComputeBudgetLimits };
