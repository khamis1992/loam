import { getApiBase, getApiHeaders } from './rpc';

export interface Schedule {
  id: string;
  prompt: string;
  intervalSeconds?: number;
  enabled?: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  cron?: string;
  runAt?: string;
  timezone?: string;
  agentId?: string;
  kind?: string;
  trigger?: string;
  githubEvents?: string[] | null;
  projectId?: string | null;
  playbook?: string | null;
}

export interface ScheduleDraft {
  prompt: string;
  intervalSeconds?: number;
  cron?: string;
  at?: string;
}

export interface SchedulePatch {
  prompt?: string;
  enabled?: boolean;
}

interface ErrorBody {
  error?: string;
}

async function request<T>(path: string, init: RequestInit, json = false): Promise<T> {
  const auth = await getApiHeaders();
  const headers: Record<string, string> = { ...(json ? { 'content-type': 'application/json' } : {}), ...auth };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as ErrorBody).error ?? `${res.status}`);
  return body as T;
}

export function listSchedules(): Promise<{ schedules?: Schedule[] }> {
  return request<{ schedules?: Schedule[] }>('/api/schedules', {});
}

export function createSchedule(draft: ScheduleDraft): Promise<{ schedule?: Schedule }> {
  return request<{ schedule?: Schedule }>('/api/schedules', { method: 'POST', body: JSON.stringify(draft) }, true);
}

export function updateSchedule(id: string, patch: SchedulePatch): Promise<{ schedule?: Schedule }> {
  return request<{ schedule?: Schedule }>(
    `/api/schedules/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    true,
  );
}

export function deleteSchedule(id: string): Promise<unknown> {
  return request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function runScheduleNow(id: string): Promise<unknown> {
  return request(`/api/schedules/${encodeURIComponent(id)}/run-now`, { method: 'POST' });
}
