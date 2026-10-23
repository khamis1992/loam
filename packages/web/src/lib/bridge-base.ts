/**
 * Core bridge infrastructure shared between FilmcraftBridge (Loam Video) and
 * CraftBridge (the Loam Craft editors: Docs, Sheets, Slides, Photo, Design).
 *
 * It holds only editor-agnostic mechanics so both bridges keep their own
 * postMessage protocol, message tags and typed surface:
 *  - the pending-call map plus per-call timeout bookkeeping
 *  - ready-callback management (waitForApi / onReady)
 *  - message-source filtering (only the embedded iframe may talk to us)
 *  - serialising calls so the editor sees one request at a time
 *  - dispose cleanup
 */

/** Identifier for an in-flight bridge call. */
export type BridgeId = string;

/** Default timeout for a single editor call. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Resolution/rejection functions for a single bridge call. */
export interface BridgePending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  /** Abort this call when it has been waiting longer than its timeout. */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Callback type for bridge readiness announcements. */
export type BridgeReadyCallback = (hasApi: boolean) => void;

/** A single message routed to a bridge (already filtered by source). */
export type BridgeMessage = { type: string; [key: string]: unknown };

/** Message tags for one bridge instance (prefix + ":call", prefix + ":result", ...). */
export interface BridgeTags {
  call: string;
  ready: string;
  result: string;
  save: string;
  open: string;
}

export function bridgeTags(prefix: string): BridgeTags {
  return {
    call: `${prefix}:call`,
    ready: `${prefix}:ready`,
    result: `${prefix}:result`,
    save: `${prefix}:save`,
    open: `${prefix}:open`,
  };
}

/** Accept only messages that came from the embedded iframe itself. */
function isFromIframe(event: MessageEvent, iframe: HTMLIFrameElement): boolean {
  return event.source === iframe.contentWindow;
}

/** Register a window message listener that ignores foreign sources. Returns the remover. */
export function addMessageListener(
  iframe: HTMLIFrameElement,
  handler: (event: MessageEvent) => void,
): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (!isFromIframe(event, iframe)) return;
    handler(event);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** Normalise a raw postMessage payload into a typed message, or null when unusable. */
export function parseBridgeMessage(
  data: unknown,
): BridgeMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.type !== 'string') return null;
  return rec as BridgeMessage;
}

/** Reject and clear every in-flight call (used on dispose and on bridge loss). */
export function rejectAllPending(pending: Map<BridgeId, BridgePending>, reason: Error): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(reason);
  }
  pending.clear();
}

/**
 * Attach the timeout that rejects a pending call once it has waited too long.
 * Returns the timer so callers can cancel it when the result arrives.
 */
export function armCallTimeout(
  pending: Map<BridgeId, BridgePending>,
  id: BridgeId,
  timeoutMs: number,
  message: string | (() => Error),
): void {
  const entry = pending.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (!pending.delete(id)) return;
    entry.reject(typeof message === 'string' ? new Error(message) : message());
  }, timeoutMs);
}

/** Resolve a pending call and cancel its timeout. */
export function settlePending(
  pending: Map<BridgeId, BridgePending>,
  id: BridgeId,
  outcome: { ok: true; value: unknown } | { ok: false; error: Error },
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(id);
  if (outcome.ok) entry.resolve(outcome.value);
  else entry.reject(outcome.error);
  return true;
}

/**
 * Register `onReady` and resolve once the editor's API becomes available.
 * A boot that reports `hasApi:false` rejects, abandoning every call still in
 * flight; a boot that never answers within `timeoutMs` rejects on timeout.
 */
export function waitForApi(
  readyCallbacks: Set<BridgeReadyCallback>,
  timeoutMs: number,
  onReady: BridgeReadyCallback,
  rejectAll: (reason: Error) => void,
): Promise<{ hasApi: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      readyCallbacks.delete(onReady);
      reject(new Error('Timed out waiting for the editor bridge'));
    }, timeoutMs);
    const onReadyOnce: BridgeReadyCallback = (hasApi: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readyCallbacks.delete(onReadyOnce);
      readyCallbacks.delete(onReady);
      if (!hasApi) {
        // A boot that reports "no API" also abandons every call still in flight.
        rejectAll(new Error('The editor did not expose its API'));
        reject(new Error('The editor did not expose its API'));
        return;
      }
      resolve({ hasApi });
    };
    readyCallbacks.add(onReadyOnce);
    // The caller's own listener broadcasts the boot flag to every other subscriber.
    readyCallbacks.add(onReady);
  });
}

/** Dispose a bridge: drop the listener and fail every in-flight call. */
export function disposeBridge(
  pending: Map<BridgeId, BridgePending>,
  readyCallbacks: Set<BridgeReadyCallback>,
  removeListener: () => void,
  reason = 'Loam bridge disposed',
): void {
  // `removeListener` is the remover returned by addMessageListener; calling it
  // detaches the exact function that was registered with addEventListener.
  removeListener();
  rejectAllPending(pending, new Error(reason));
  readyCallbacks.clear();
}

/**
 * A tiny per-bridge queue: editor calls are sent one at a time so the control
 * channel (and the editor's own undo history) stays deterministic. Read-only
 * inspection calls may be allowed through in parallel with {@link allowOverlap}.
 */
export class BridgeQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `task` after every earlier task has settled. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    const next = this.tail.then(task, task).finally(() => {
      this.active -= 1;
    });
    // Keep the chain alive even when a task rejects.
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** True while at least one task is still in flight. */
  get busy(): boolean {
    return this.active > 0;
  }

  private active = 0;
}

/** Default method name for editor calls. */
export const DEFAULT_METHOD = 'engine.execute';
