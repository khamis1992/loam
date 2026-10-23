/**
 * D12: managed child sessions (coordinator/children).
 *
 * A coordinator agent starts a child session with an explicit budget (max
 * steps / max tokens / max time), can message it while it runs, put it to
 * sleep, wake it, answer its questions, or terminate it. The coordinator is
 * WOKEN by an event when a child finishes or asks for input -- there is no
 * polling loop on the coordinator side. A coordinator can also schedule a
 * one-shot self-reminder through the existing schedule store.
 *
 * The registry is transport-agnostic: the caller supplies a `runner` that
 * drives the child (the managed session tools build one from `runAgent`).
 * Budget enforcement happens through the run context, so a child that exceeds
 * its budget stops with status `budget_exceeded`.
 */
import { addSchedule } from "./db.js";
import { log } from "../log.js";

export type BudgetKind = "steps" | "tokens" | "time";

/** Thrown by the run context when a child crosses a budget boundary. */
export class BudgetExceededError extends Error {
  readonly kind: BudgetKind;
  constructor(kind: BudgetKind) {
    super(`child session exceeded its ${kind} budget`);
    this.name = "BudgetExceededError";
    this.kind = kind;
  }
}

export interface ManagedChildBudget {
  maxSteps?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export type ManagedChildStatus =
  | "running"
  | "sleeping"
  | "waiting_input"
  | "done"
  | "budget_exceeded"
  | "terminated"
  | "failed";

export interface ManagedChild {
  id: string;
  parentAgentId: string;
  childAgentId: string;
  prompt: string;
  budget: ManagedChildBudget;
  status: ManagedChildStatus;
  steps: number;
  tokens: number;
  createdAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
}

export interface ManagedChildEvent {
  type: "finish" | "needs_input";
  childId: string;
  parentAgentId: string;
  status?: ManagedChildStatus;
  output?: string;
  error?: string;
  question?: string;
}

/** Hooks a child runner uses to report progress and talk to the coordinator. */
export interface ChildRunContext {
  readonly childId: string;
  readonly parentAgentId: string;
  readonly budget: ManagedChildBudget;
  readonly signal: AbortSignal;
  /** Charge one step; throws BudgetExceededError past maxSteps. */
  reportStep(): void;
  /** Charge tokens; throws BudgetExceededError past maxTokens. */
  reportTokens(count: number): void;
  /** Messages the coordinator delivered since the last call. */
  consumeMessages(): string[];
  /** Surface a question to the coordinator and await its answer. */
  requestInput(question: string): Promise<string>;
  isSleeping(): boolean;
  isTerminated(): boolean;
  status(): ManagedChildStatus;
}

export type ManagedChildRunner = (ctx: ChildRunContext) => Promise<string>;

export interface StartManagedChildInput {
  parentAgentId: string;
  childAgentId: string;
  prompt: string;
  budget?: ManagedChildBudget;
  runner?: ManagedChildRunner;
  title?: string;
}

interface ManagedChildInternal extends ManagedChild {
  messages: string[];
  controller: AbortController;
  timer?: NodeJS.Timeout;
  finishEmitted: boolean;
  pendingQuestion?: string;
  resolveInput?: (answer: string) => void;
}

let seq = 0;
function nextChildId(): string {
  seq += 1;
  return `mchild_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function normalizeBudget(budget?: ManagedChildBudget): ManagedChildBudget {
  const out: ManagedChildBudget = {};
  if (budget?.maxSteps !== undefined) {
    const v = Math.floor(budget.maxSteps);
    if (!Number.isFinite(v) || v < 1) throw new Error("maxSteps must be a positive integer");
    out.maxSteps = v;
  }
  if (budget?.maxTokens !== undefined) {
    const v = Math.floor(budget.maxTokens);
    if (!Number.isFinite(v) || v < 1) throw new Error("maxTokens must be a positive integer");
    out.maxTokens = v;
  }
  if (budget?.timeoutMs !== undefined) {
    const v = Math.floor(budget.timeoutMs);
    if (!Number.isFinite(v) || v < 1) throw new Error("timeoutMs must be a positive integer");
    out.timeoutMs = v;
  }
  return out;
}

export class ManagedSessionRegistry {
  private readonly children = new Map<string, ManagedChildInternal>();
  private readonly wakeHandlers = new Map<string, Set<(event: ManagedChildEvent) => void>>();
  private readonly anyWakeHandlers = new Set<(event: ManagedChildEvent) => void>();

  /** Start a child session. Returns immediately; the runner runs in the background. */
  start(input: StartManagedChildInput): ManagedChild {
    const parentAgentId = input.parentAgentId.trim();
    const childAgentId = input.childAgentId.trim();
    const prompt = input.prompt.trim();
    if (!parentAgentId) throw new Error("managed child requires a parent agent id");
    if (!childAgentId) throw new Error("managed child requires a child agent id");
    if (!prompt) throw new Error("managed child requires a prompt");
    const budget = normalizeBudget(input.budget);

    const now = new Date().toISOString();
    const controller = new AbortController();
    const child: ManagedChildInternal = {
      id: nextChildId(),
      parentAgentId,
      childAgentId,
      prompt,
      budget,
      status: "running",
      steps: 0,
      tokens: 0,
      createdAt: now,
      messages: [],
      controller,
      finishEmitted: false,
    };
    this.children.set(child.id, child);

    if (budget.timeoutMs) {
      child.timer = setTimeout(() => {
        controller.abort();
        this.finalize(child, "budget_exceeded", undefined, `child exceeded its ${budget.timeoutMs}ms time budget`);
      }, budget.timeoutMs);
      child.timer.unref?.();
    }

    const ctx = this.createContext(child);
    const runner = input.runner ?? this.defaultRunner.bind(this);
    void Promise.resolve()
      .then(() => runner(ctx))
      .then((output) => {
        if (child.status === "terminated") return;
        this.finalize(child, "done", output);
      })
      .catch((err: unknown) => {
        if (child.status === "terminated") return;
        if (err instanceof BudgetExceededError) {
          this.finalize(child, "budget_exceeded", undefined, err.message);
          return;
        }
        if (controller.signal.aborted) {
          this.finalize(child, "terminated", undefined, "child session aborted");
          return;
        }
        this.finalize(child, "failed", undefined, err instanceof Error ? err.message : String(err));
      });

    log.info(`managed child started: ${child.id} parent=${parentAgentId} child=${childAgentId} budget=${JSON.stringify(budget)}`);
    return this.publicView(child);
  }

  private defaultRunner(ctx: ChildRunContext): Promise<string> {
    void ctx;
    return Promise.reject(new Error("no runner provided for managed child session"));
  }

  private createContext(child: ManagedChildInternal): ChildRunContext {
    return {
      childId: child.id,
      parentAgentId: child.parentAgentId,
      budget: child.budget,
      signal: child.controller.signal,
      reportStep: () => {
        child.steps += 1;
        if (child.budget.maxSteps !== undefined && child.steps > child.budget.maxSteps) {
          throw new BudgetExceededError("steps");
        }
      },
      reportTokens: (count: number) => {
        const n = Math.max(0, Math.floor(count));
        child.tokens += n;
        if (child.budget.maxTokens !== undefined && child.tokens > child.budget.maxTokens) {
          throw new BudgetExceededError("tokens");
        }
      },
      consumeMessages: () => {
        if (child.messages.length === 0) return [];
        const out = child.messages.slice();
        child.messages.length = 0;
        return out;
      },
      requestInput: (question: string) => {
        if (child.status === "terminated") return Promise.resolve("");
        child.status = "waiting_input";
        child.pendingQuestion = question;
        this.emitWake(child, { type: "needs_input", childId: child.id, parentAgentId: child.parentAgentId, question });
        return new Promise<string>((resolve) => {
          child.resolveInput = resolve;
        });
      },
      isSleeping: () => child.status === "sleeping",
      isTerminated: () => child.status === "terminated",
      status: () => child.status,
    };
  }

  private finalize(child: ManagedChildInternal, status: ManagedChildStatus, output?: string, error?: string): void {
    if (child.finishEmitted) return;
    child.finishEmitted = true;
    if (child.timer) clearTimeout(child.timer);
    child.status = status;
    child.finishedAt = new Date().toISOString();
    if (output !== undefined) child.output = output;
    if (error !== undefined) child.error = error;
    const resolve = child.resolveInput;
    child.resolveInput = undefined;
    resolve?.("");
    this.emitWake(child, {
      type: "finish",
      childId: child.id,
      parentAgentId: child.parentAgentId,
      status,
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    log.info(`managed child finished: ${child.id} status=${status}`);
  }

  private emitWake(child: ManagedChildInternal, event: ManagedChildEvent): void {
    const handlers = this.wakeHandlers.get(child.parentAgentId);
    if (handlers) {
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (err) {
          log.warn(`managed child wake handler failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    for (const handler of [...this.anyWakeHandlers]) {
      try {
        handler(event);
      } catch (err) {
        log.warn(`managed child wake handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Subscribe to finish/needs_input events for one coordinator. Returns an unsubscribe. */
  onCoordinatorWake(parentAgentId: string, handler: (event: ManagedChildEvent) => void): () => void {
    const key = parentAgentId.trim();
    let set = this.wakeHandlers.get(key);
    if (!set) {
      set = new Set();
      this.wakeHandlers.set(key, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.wakeHandlers.delete(key);
    };
  }

  /** Subscribe to every coordinator wake event (used to enqueue parent runs). */
  onAnyCoordinatorWake(handler: (event: ManagedChildEvent) => void): () => void {
    this.anyWakeHandlers.add(handler);
    return () => {
      this.anyWakeHandlers.delete(handler);
    };
  }

  /** Deliver a message to a running (or sleeping) child. */
  message(childId: string, message: string): boolean {
    const child = this.children.get(childId);
    if (!child) return false;
    const text = message.trim();
    if (!text) return false;
    if (child.status !== "running" && child.status !== "sleeping") return false;
    child.messages.push(text);
    return true;
  }

  sleep(childId: string): boolean {
    const child = this.children.get(childId);
    if (!child || child.status !== "running") return false;
    child.status = "sleeping";
    return true;
  }

  wake(childId: string): boolean {
    const child = this.children.get(childId);
    if (!child || child.status !== "sleeping") return false;
    child.status = "running";
    return true;
  }

  terminate(childId: string): boolean {
    const child = this.children.get(childId);
    if (!child) return false;
    if (child.status === "done" || child.status === "budget_exceeded" || child.status === "terminated" || child.status === "failed") {
      return false;
    }
    child.controller.abort();
    this.finalize(child, "terminated", undefined, "child session terminated by coordinator");
    return true;
  }

  /** Answer a child that is waiting for input. */
  answerInput(childId: string, answer: string): boolean {
    const child = this.children.get(childId);
    if (!child || child.status !== "waiting_input") return false;
    child.status = "running";
    delete child.pendingQuestion;
    const resolve = child.resolveInput;
    child.resolveInput = undefined;
    resolve?.(answer);
    return true;
  }

  get(childId: string): ManagedChild | undefined {
    const child = this.children.get(childId);
    return child ? this.publicView(child) : undefined;
  }

  list(parentAgentId?: string): ManagedChild[] {
    const all = [...this.children.values()];
    const scoped = parentAgentId ? all.filter((c) => c.parentAgentId === parentAgentId) : all;
    return scoped.map((c) => this.publicView(c));
  }

  pendingQuestion(childId: string): string | undefined {
    return this.children.get(childId)?.pendingQuestion;
  }

  /** Resolve once the child finishes (test/helper; production uses wake events). */
  waitFinished(childId: string, timeoutMs = 5000): Promise<ManagedChild> {
    const child = this.children.get(childId);
    if (!child) return Promise.reject(new Error(`managed child not found: ${childId}`));
    if (child.finishEmitted) return Promise.resolve(this.publicView(child));
    return new Promise<ManagedChild>((resolve, reject) => {
      let done = false;
      let off: () => void = () => {};
      const finish = (event: ManagedChildEvent): void => {
        if (event.childId !== childId || event.type !== "finish") return;
        done = true;
        clearTimeout(timer);
        off();
        resolve(this.publicView(child));
      };
      const timer = setTimeout(() => {
        if (done) return;
        off();
        reject(new Error(`timed out waiting for managed child ${childId}`));
      }, timeoutMs);
      off = this.onAnyCoordinatorWake(finish);
    });
  }

  /** Schedule a one-shot reminder bound to the coordinator's agent. */
  scheduleSelfReminder(parentAgentId: string, at: string, prompt: string): { id: string } {
    const parent = parentAgentId.trim();
    const text = prompt.trim();
    if (!parent) throw new Error("self reminder requires a parent agent id");
    if (!text) throw new Error("self reminder requires a prompt");
    const schedule = addSchedule(text, 3600, parent, undefined, undefined, undefined, true, { runAt: at });
    return { id: schedule.id };
  }

  private publicView(child: ManagedChildInternal): ManagedChild {
    return {
      id: child.id,
      parentAgentId: child.parentAgentId,
      childAgentId: child.childAgentId,
      prompt: child.prompt,
      budget: child.budget,
      status: child.status,
      steps: child.steps,
      tokens: child.tokens,
      createdAt: child.createdAt,
      ...(child.finishedAt ? { finishedAt: child.finishedAt } : {}),
      ...(child.output !== undefined ? { output: child.output } : {}),
      ...(child.error !== undefined ? { error: child.error } : {}),
    };
  }
}

/** Process-wide registry used by the managed session tools. */
export const managedSessions = new ManagedSessionRegistry();
