import { getApiBase, getApiHeaders } from './rpc';

/**
 * J7 idle session hibernation (renderer side), mirroring the daemon record in
 * `src/memory/hibernation.ts`. The renderer never releases authoritative state:
 * it drops the *derived* render state it owns (the collapsed-event fold, the
 * memoized rows and the markdown/highlight work that went into them) while the
 * canonical event list, the input draft and the scroll position stay intact.
 */
export type HibernationState = 'active' | 'idle' | 'hibernated';

export interface SessionHibernationSnapshot {
  sessionId: string;
  state: HibernationState;
  hibernations: number;
  lastReleasedEntries: number;
  lastReleasedBytes: number;
  msUntilHibernation?: number;
  /** True when the disable setting (0 minutes) turned the feature off. */
  disabled: boolean;
}

export interface SessionHibernationResponse {
  record: SessionHibernationSnapshot;
  state: HibernationState;
  releasedEntries?: number;
  releasedBytes?: number;
  error?: string;
}

interface ErrorBody {
  error?: string;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, init);
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as ErrorBody).error || `${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

function hibernationPath(sessionId: string, action?: string): string {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/hibernation`;
  // The daemon route matches `/api/sessions/:id/(hibernation|hibernate|wake)`,
  // so the actions are siblings of the snapshot, not children of it.
  return action ? `/api/sessions/${encodeURIComponent(sessionId)}/${action}` : base;
}

/** Read one session's hibernation state (state, counts, ms until idle). */
export async function fetchSessionHibernation(
  sessionId: string,
  headers?: Record<string, string>,
): Promise<SessionHibernationSnapshot> {
  const res = await jsonFetch<{ record: SessionHibernationSnapshot | null; state: HibernationState; msUntilHibernation?: number; disabled: boolean }>(
    hibernationPath(sessionId),
    headers ? { headers } : undefined,
  );
  return {
    sessionId,
    state: res.state,
    hibernations: res.record?.hibernations ?? 0,
    lastReleasedEntries: res.record?.lastReleasedEntries ?? 0,
    lastReleasedBytes: res.record?.lastReleasedBytes ?? 0,
    ...(res.msUntilHibernation !== undefined ? { msUntilHibernation: res.msUntilHibernation } : {}),
    disabled: res.disabled,
  };
}

/**
 * Request immediate hibernation (the test hook: it bypasses the elapsed-time
 * requirement, never the active-work guards or the disable setting).
 */
export async function requestHibernation(
  sessionId: string,
  headers?: Record<string, string>,
): Promise<SessionHibernationResponse> {
  return jsonFetch<SessionHibernationResponse>(hibernationPath(sessionId, 'hibernate'), {
    method: 'POST',
    ...(headers ? { headers } : {}),
  });
}

/** Wake a hibernated session — the same wake the first keystroke performs. */
export async function wakeHibernatedSession(
  sessionId: string,
  headers?: Record<string, string>,
): Promise<SessionHibernationResponse> {
  return jsonFetch<SessionHibernationResponse>(hibernationPath(sessionId, 'wake'), {
    method: 'POST',
    ...(headers ? { headers } : {}),
  });
}

/** Convenience wrapper that adds the local auth headers (renderer callers). */
export async function wakeHibernatedSessionWithAuth(sessionId: string): Promise<SessionHibernationResponse> {
  return wakeHibernatedSession(sessionId, await getApiHeaders());
}
