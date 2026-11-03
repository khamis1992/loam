/**
 * Loam Remote (/remote) — mobile PWA companion screen.
 *
 * The page itself is served publicly (like /share and /portal), but every
 * /api call it makes carries the install token (`x-loam-local-token`) which
 * the user pastes once and is kept in localStorage. All endpoints are
 * same-origin relative paths so the phone reaches Loam over LAN/Tailscale
 * with zero cloud in the middle.
 */

export const REMOTE_TOKEN_STORAGE_KEY = 'loam.remote.token';

export type RemoteTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'cancelled';

export interface RemoteTaskSummary {
  id: string;
  title: string;
  status: RemoteTaskStatus;
  mode?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  stepCount?: number;
}

export interface RemoteTaskMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
}

export interface RemoteTaskDetail {
  task: RemoteTaskSummary & { messages: RemoteTaskMessage[] };
  recovery: { resumable: boolean; requiresConfirmation: boolean; completedSteps: number } | null;
}

/** Error carrying the HTTP status so the UI can distinguish a bad token (401)
 *  from endpoint errors (404/409) and replay-confirmation requests. */
export class RemoteApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'RemoteApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function loadToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REMOTE_TOKEN_STORAGE_KEY, token);
  } catch {
    /* private mode / disabled storage: keep going with the in-memory value */
  }
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(REMOTE_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** fetch with the install token header. Throws RemoteApiError on !res.ok. */
export async function remoteFetch(path: string, token: string, init?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = { 'x-loam-local-token': token };
  if (init?.body != null) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const data = payload as { error?: unknown; message?: unknown } | null;
    const message = typeof data?.error === 'string' && data.error
      ? data.error
      : typeof data?.message === 'string' && data.message
        ? data.message
        : `HTTP ${res.status}`;
    throw new RemoteApiError(res.status, message, payload);
  }
  return payload;
}

/** GET /api/tasks — also doubles as token validation (it is token-gated,
 *  unlike the public /api/health and /api/identity). */
export async function listRemoteTasks(token: string): Promise<RemoteTaskSummary[]> {
  const data = (await remoteFetch('/api/tasks', token)) as { tasks?: RemoteTaskSummary[] };
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

/** GET /api/tasks/:id — full task including messages plus resume recovery info. */
export async function getRemoteTaskDetail(id: string, token: string): Promise<RemoteTaskDetail> {
  return (await remoteFetch(`/api/tasks/${encodeURIComponent(id)}`, token)) as RemoteTaskDetail;
}

/** POST /api/tasks/:id/cancel — cooperative stop between steps. */
export async function stopRemoteTask(id: string, token: string): Promise<{ ok: boolean; note?: string }> {
  return (await remoteFetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, token, {
    method: 'POST',
    body: '{}',
  })) as { ok: boolean; note?: string };
}

/** POST /api/tasks/:id/resume — resume an interrupted/cancelled saved run.
 *  The server answers 409 + requiresConfirmation when the interrupted step may
 *  have already executed; retry with retryInterruptedStep after the user okays. */
export async function resumeRemoteTask(id: string, token: string, retryInterruptedStep = false): Promise<{ taskId: string; status?: string }> {
  return (await remoteFetch(`/api/tasks/${encodeURIComponent(id)}/resume`, token, {
    method: 'POST',
    body: JSON.stringify({ retryInterruptedStep }),
  })) as { taskId: string; status?: string };
}
