import { getApiBase, getApiHeaders } from './rpc';

/** D19 session runtime state, mirroring the server snapshot in
 *  src/server/sessionRuntime.ts. */
export interface SessionRuntimeSnapshot {
  sessionId: string;
  state: string;
  sleeping: boolean;
  budget: {
    steps: number;
    stepLimit?: number;
    tokens: number;
    tokenLimit?: number;
    percent: number;
    warning?: string;
    stopped: boolean;
  };
  msUntilSleep?: number;
  raised: boolean;
}

export interface SessionRuntimeDefaults {
  idleMinutes: number;
  stepLimit: number;
  tokenLimit: number;
}

export interface SessionRuntimeResponse {
  session: SessionRuntimeSnapshot;
  defaults: SessionRuntimeDefaults;
  raised?: boolean;
}

/** Default raise amounts: enough to keep working without asking again. */
export const DEFAULT_RAISE_STEPS = 40;
export const DEFAULT_RAISE_TOKENS = 500_000;

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

function runtimePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/runtime`;
}

/** Poll target for the badge: sleep state + compute budget. */
export async function fetchSessionRuntime(sessionId: string, headers?: Record<string, string>): Promise<SessionRuntimeResponse> {
  return jsonFetch<SessionRuntimeResponse>(runtimePath(sessionId), headers ? { headers } : undefined);
}

/** Force the session to sleep, releasing its browser/pty resources. */
export async function sleepSession(sessionId: string, headers?: Record<string, string>): Promise<SessionRuntimeResponse> {
  return jsonFetch<SessionRuntimeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/sleep`, {
    method: 'POST',
    ...(headers ? { headers } : {}),
  });
}

/** Force a sleeping session awake, restoring what was released. */
export async function wakeSession(sessionId: string, headers?: Record<string, string>): Promise<SessionRuntimeResponse> {
  return jsonFetch<SessionRuntimeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/wake`, {
    method: 'POST',
    ...(headers ? { headers } : {}),
  });
}

/** Raise the compute ceiling; a raise clears the stop so the run can continue. */
export async function raiseSessionBudget(
  sessionId: string,
  delta: { steps?: number; tokens?: number },
  headers?: Record<string, string>,
): Promise<SessionRuntimeResponse> {
  return jsonFetch<SessionRuntimeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/budget`, {
    method: 'POST',
    headers: { ...(headers ?? {}), 'content-type': 'application/json' },
    body: JSON.stringify(delta),
  });
}

/** Convenience for the badge's "Raise budget" button, using the auth headers. */
export async function raiseSessionBudgetDefault(sessionId: string): Promise<SessionRuntimeResponse> {
  return raiseSessionBudget(
    sessionId,
    { steps: DEFAULT_RAISE_STEPS, tokens: DEFAULT_RAISE_TOKENS },
    await getApiHeaders(),
  );
}
