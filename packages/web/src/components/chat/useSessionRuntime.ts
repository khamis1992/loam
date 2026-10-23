'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchSessionRuntime,
  raiseSessionBudgetDefault,
  wakeSession,
  type SessionRuntimeSnapshot,
} from '@/services/sessionRuntimeApi';
import { getApiHeaders } from '@/services/rpc';

/** Poll cadence for the badge. Sleep transitions happen on a 60s sweep server
 *  side, so 15s keeps the badge responsive without hammering the API. */
export const RUNTIME_POLL_MS = 15_000;

export interface SessionRuntimeController {
  snapshot: SessionRuntimeSnapshot | undefined;
  loading: boolean;
  error: string | undefined;
  /** Pull the current state now (used after a send so the badge reacts fast). */
  refresh: () => Promise<void>;
  raiseBudget: () => Promise<void>;
  wake: () => Promise<void>;
}

/**
 * Poll one session's runtime state (sleep + compute budget) and expose the
 * raise/wake actions the badge needs. Polling stops when the page is hidden so
 * a background tab never wakes a sleeping session by polling alone.
 */
export function useSessionRuntime(
  sessionId: string,
  options: { pollMs?: number; enabled?: boolean } = {},
): SessionRuntimeController {
  const { pollMs = RUNTIME_POLL_MS, enabled = true } = options;
  const [snapshot, setSnapshot] = useState<SessionRuntimeSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const headers = await getApiHeaders();
      const res = await fetchSessionRuntime(sessionId, headers);
      setSnapshot(res.session);
      setError(undefined);
    } catch (e) {
      // A runtime endpoint failure must never break the chat; the badge simply
      // stays at its last known state.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  const raiseBudget = useCallback(async () => {
    try {
      const res = await raiseSessionBudgetDefault(sessionId);
      setSnapshot(res.session);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const wake = useCallback(async () => {
    try {
      const headers = await getApiHeaders();
      const res = await wakeSession(sessionId, headers);
      setSnapshot(res.session);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  return { snapshot, loading, error, refresh, raiseBudget, wake };
}
