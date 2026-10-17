/** Per-run cancellation registry: taskId → AbortController for the active agent run. */
const controllers = new Map<string, AbortController>();
const cancelled = new Set<string>();
const active = new Set<string>();
/** Monotonic counter bumped on every cancel — lets any in-flight tool notice it. */
let cancelEpoch = 0;

/** Thrown everywhere a run notices the user pressed stop — never swallowed by fallbacks. */
export class CancelledError extends Error {
  constructor(message = "cancelled by user") {
    super(message);
    this.name = "CancelledError";
  }
}

/** True when the error is (or came from) a user cancellation — aborts, fetch aborts, CancelledError. */
export function isCancelledError(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "CancelledError") return true;
    const msg = err.message ?? "";
    if (msg === "cancelled by user" || /This operation was aborted/i.test(msg)) return true;
  }
  return false;
}

/** Throws CancelledError when the run was stopped by the user (abort signal or cancel registry). */
export function throwIfCancelled(signal: AbortSignal | undefined, taskId: string | undefined): void {
  if (signal?.aborted || isCancelled(taskId)) throw new CancelledError();
}

export function currentCancelEpoch(): number {
  return cancelEpoch;
}

export function createRunSignal(taskId: string, isActive = true): AbortSignal {
  const ac = new AbortController();
  controllers.set(taskId, ac);
  cancelled.delete(taskId);
  if (isActive) active.add(taskId);
  return ac.signal;
}

export function activateRunSignal(taskId: string): void { active.add(taskId); }

export function cancelRunSignal(taskId: string): boolean {
  if (active.has(taskId)) cancelEpoch += 1;
  cancelled.add(taskId);
  const ac = controllers.get(taskId);
  if (!ac) return false;
  try {
    ac.abort();
  } catch {
    /* ignore */
  }
  return true;
}

/** True once a cancel was requested for this task (works even when a blocking
 *  tool is running and the abort signal never reaches it). */
export function isCancelled(taskId: string | undefined): boolean {
  return Boolean(taskId && cancelled.has(taskId));
}

export function clearRunSignal(taskId: string): void {
  controllers.delete(taskId);
  active.delete(taskId);
  cancelled.delete(taskId);
}

export function listRunningSignals(): string[] {
  return [...controllers.keys()];
}
