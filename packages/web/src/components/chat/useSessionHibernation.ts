'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchSessionHibernation,
  requestHibernation,
  wakeHibernatedSessionWithAuth,
  type SessionHibernationSnapshot,
} from '@/services/sessionHibernationApi';
import { getApiHeaders } from '@/services/rpc';
import {
  releaseDerivedChatState,
  setDerivedChatState,
  buildDerivedChatState,
} from './hibernationStore';
import type { ChatEvent } from '@shared/socket';

/** How often the renderer checks the daemon's idle state (server sweeps at 60s,
 *  so 15s keeps the "hibernated" chip responsive without rebuilding anything). */
export const HIBERNATION_POLL_MS = 15_000;

/** Minimum idle time before the *renderer* releases its own derived state. The
 *  daemon owns the authoritative threshold; the renderer matches it so a local
 *  release never runs ahead of the daemon's guards. */
export const DEFAULT_RENDERER_IDLE_MS = 30 * 60_000;

export interface SessionHibernationController {
  snapshot: SessionHibernationSnapshot | undefined;
  loading: boolean;
  error: string | undefined;
  /** True when this view released its derived render state. */
  hibernated: boolean;
  /** Release now (the test hook: bypasses the elapsed-time requirement). */
  hibernate: () => Promise<void>;
  /** Wake: the same wake the first keystroke performs. */
  wake: () => Promise<void>;
  /** Called on the first keystroke; wakes without touching the draft. */
  onFirstInput: (draft: string) => Promise<void>;
  refresh: () => Promise<void>;
}

interface Options {
  /** Idle threshold in ms for the renderer's own release (default 30 min). */
  idleMs?: number;
  pollMs?: number;
  enabled?: boolean;
}

/**
 * J7 renderer hibernation for one open chat view.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md: the *first keystroke*
 * wakes the session, and the keystroke is never lost — `onFirstInput` receives
 * the draft the composer already holds and only then asks the daemon to wake.
 * Read-only polling and housekeeping never wake a session, so the idle clock is
 * not reset by the debug surface.
 *
 * The renderer releases only its own derived state (the folded event list and
 * the memoized rows). The canonical events, the draft, the task id and the
 * scroll position survive untouched.
 */
export function useSessionHibernation(
  sessionId: string,
  events: readonly ChatEvent[],
  options: Options = {},
): SessionHibernationController {
  const { idleMs = DEFAULT_RENDERER_IDLE_MS, pollMs = HIBERNATION_POLL_MS, enabled = true } = options;
  const [snapshot, setSnapshot] = useState<SessionHibernationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hibernated, setHibernated] = useState(false);
  const inFlight = useRef(false);
  const lastActivityRef = useRef<number>(Date.now());
  const releasedRef = useRef(false);

  // Keep the derived fold in one place: rebuilt on every event change, dropped
  // by `hibernate`, rebuilt again on the next render after a wake.
  useEffect(() => {
    if (!sessionId || events.length === 0) return;
    setDerivedChatState(buildDerivedChatState(sessionId, events));
  }, [sessionId, events]);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const headers = await getApiHeaders();
      const next = await fetchSessionHibernation(sessionId, headers);
      setSnapshot(next);
      setError(undefined);
      if (next.state === 'active') {
        releasedRef.current = false;
        setHibernated(false);
      }
    } catch (e) {
      // A hibernation endpoint failure must never break the chat.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [sessionId]);

  const hibernate = useCallback(async () => {
    lastActivityRef.current = Date.now();
    try {
      const headers = await getApiHeaders();
      await requestHibernation(sessionId, headers);
      // Local release: the canonical events stay in the store, so the fold is
      // rebuilt on the next render. Only the derived work is discarded.
      releaseDerivedChatState(sessionId);
      releasedRef.current = true;
      setHibernated(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, refresh]);

  const wake = useCallback(async () => {
    try {
      await wakeHibernatedSessionWithAuth(sessionId);
      releasedRef.current = false;
      setHibernated(false);
      lastActivityRef.current = Date.now();
      // Rebuild the derived fold immediately so the transcript repaints without
      // waiting for the next event.
      if (events.length > 0) setDerivedChatState(buildDerivedChatState(sessionId, events));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, events, refresh]);

  /**
   * The first keystroke wakes the session. The draft is passed in by the
   * composer *before* it is sent, so the character is never dropped: waking is
   * a state change, not a re-render of the input.
   */
  const onFirstInput = useCallback(async (draft: string) => {
    lastActivityRef.current = Date.now();
    if (!releasedRef.current && !hibernated) return;
    if (draft.length === 0) return;
    await wake();
  }, [hibernated, wake]);

  // Idle release: only after a sustained idle period, and never while a run is
  // active (the daemon's guards would refuse anyway; this avoids a wasted call).
  useEffect(() => {
    if (!enabled || idleMs <= 0) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (releasedRef.current) return;
      if (snapshot?.disabled) return;
      if (Date.now() - lastActivityRef.current < idleMs) return;
      void hibernate();
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, idleMs, pollMs, hibernate, snapshot?.disabled]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      // A background tab must never wake a session by polling alone.
      if (typeof document !== 'undefined' && document.hidden) return;
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  return { snapshot, loading, error, hibernated, hibernate, wake, onFirstInput, refresh };
}
