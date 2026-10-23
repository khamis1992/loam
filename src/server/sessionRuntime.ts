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

  constructor(options: SessionRuntimeOptions = {}) {
    this.stepLimit = options.stepLimit;
    this.tokenLimit = options.tokenLimit;
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
      entry = { budget: createComputeBudget({ stepLimit: this.stepLimit, tokenLimit: this.tokenLimit }) };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  /* ------------------------------ budget ------------------------------ */

  getBudget(sessionId: string): ComputeBudget {
    return this.ensure(sessionId).budget;
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

  /** Evaluate the budget and remember the warning/stop reason. */
  evaluate(sessionId: string): ReturnType<typeof checkBudget> {
    const entry = this.ensure(sessionId);
    const decision = checkBudget(entry.budget, { stepLimit: this.stepLimit, tokenLimit: this.tokenLimit });
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
  raise(sessionId: string, delta: { steps?: number; tokens?: number }): { ok: boolean; reason?: string; budget: ComputeBudget } {
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
    budget: { steps: number; stepLimit?: number; tokens: number; tokenLimit?: number; percent: number; warning?: string; stopped: boolean };
    sleeping: boolean;
    msUntilSleep?: number;
    raised: boolean;
  } {
    const entry = this.ensure(sessionId);
    const budget = entry.budget;
    const stepPct = budget.stepLimit ? budget.steps / budget.stepLimit : 0;
    const tokenPct = budget.tokenLimit ? totalTokens(budget) / budget.tokenLimit : 0;
    return {
      sessionId,
      state: this.sleep.getState(sessionId),
      budget: {
        steps: budget.steps,
        ...(budget.stepLimit !== undefined ? { stepLimit: budget.stepLimit } : {}),
        tokens: totalTokens(budget),
        ...(budget.tokenLimit !== undefined ? { tokenLimit: budget.tokenLimit } : {}),
        percent: Math.round(Math.max(stepPct, tokenPct) * 100),
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
