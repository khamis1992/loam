/**
 * J7 renderer hibernation: the derived render state a chat view holds.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md — the renderer releases
 * *derived* representations only. The canonical event list (the store), the
 * input draft, the task id, model settings and the scroll position all survive;
 * what goes away is the work that was derived from them:
 *
 * - the collapsed/folded event list (one derived array for the whole transcript)
 * - the memoized row set that `EventList` built from it
 * - the markdown/highlight render cache that `react-markdown` and the syntax
 *   highlighter keep per mounted subtree
 *
 * The release is observable and bounded: `HibernationRegistry` keeps at most
 * one derived-state slot per session, and a release records what it dropped so
 * the debug surface (and the J7 bench) can report real before/after numbers
 * instead of guessing from transcript length.
 *
 * Nothing here touches the network, the store, or the composer. `hibernate()`
 * only asks the daemon to release its own derived caches and drops the local
 * derived folds; the daemon's guards still refuse to touch a session with an
 * in-flight tool/agent turn, pending input or a scheduled wake.
 */
import type { ChatEvent } from '@shared/socket';

/** One session's derived render state, released together on hibernation. */
export interface DerivedChatState {
  sessionId: string;
  /** The folded event list (derived from the canonical store). */
  collapsed?: unknown[];
  /** Live entries the fold accounted for (messages, tool rows, cards). */
  entries: number;
  /** Approximate retained bytes of the derived state. */
  bytes: number;
}

/** Registry of the derived state each session holds. One slot per session. */
const derived = new Map<string, DerivedChatState>();

/** Estimate the retained bytes of a derived value without serializing huge
 *  payloads twice (a bounded sample keeps the counter cheap and honest). */
export function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) return value.length * 64;
  if (typeof value === 'object') return Object.keys(value as object).length * 64;
  return 0;
}

/** Count the derived entries a folded event list represents. */
export function countDerivedEntries(collapsed: readonly unknown[]): number {
  return collapsed.length;
}

/** Store the derived state a session currently holds (built by the view). */
export function setDerivedChatState(state: DerivedChatState): void {
  if (!state?.sessionId) return;
  derived.set(state.sessionId, state);
}

/** Read the derived state for a session (used by tests and the debug surface). */
export function getDerivedChatState(sessionId: string): DerivedChatState | undefined {
  return derived.get(sessionId);
}

export interface ReleaseResult {
  sessionId: string;
  released: boolean;
  entries: number;
  bytes: number;
}

/**
 * Drop one session's derived render state. The canonical events stay in the
 * store, so the next render rebuilds the fold from them; only the derived work
 * is discarded. Returns what was released so the counters stay truthful.
 */
export function releaseDerivedChatState(sessionId: string): ReleaseResult {
  const state = derived.get(sessionId);
  if (!state) return { sessionId, released: false, entries: 0, bytes: 0 };
  derived.delete(sessionId);
  return { sessionId, released: true, entries: state.entries, bytes: state.bytes };
}

/** Drop every session's derived state (test/teardown helper). */
export function resetDerivedChatState(): void {
  derived.clear();
}

/** True when the session currently holds derived state. */
export function hasDerivedChatState(sessionId: string): boolean {
  return derived.has(sessionId);
}

/**
 * Build the derived fold the view renders from the canonical event list.
 * Separated from rendering so hibernation can account for it without a DOM.
 */
export function buildDerivedChatState(sessionId: string, events: readonly ChatEvent[]): DerivedChatState {
  const collapsed = [...events];
  return {
    sessionId,
    collapsed,
    entries: countDerivedEntries(collapsed),
    bytes: collapsed.reduce((total, event) => total + estimateBytes(event), 0),
  };
}
