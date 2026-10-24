import { getApiBase, getApiHeaders } from './rpc';

/**
 * Client for the Harness2 learned-lessons surface (H9).
 *
 * Talks to the `/api/learning/lessons` routes in the Loam server, which read
 * the same store the agent's correction learning writes to
 * (`src/learning/harness/experienceStore.ts`). The panel is therefore a
 * truthful view of what the agent will inject, not a parallel copy.
 *
 * Contract (BUILD_SPEC section 8):
 *   GET    /api/learning/lessons?agentId=&domain=  -> { data: Lesson[] }  (vectors stripped)
 *   PATCH  /api/learning/lessons/:id { disabled } -> { data: Lesson } | 404
 *   DELETE /api/learning/lessons/:id              -> 204 | 404
 */

export type LessonSource = 'correction' | 'critic' | 'selfplay';
export type Confidence = 'low' | 'medium' | 'high';

export interface Lesson {
  id: string;
  agentId: string | null;
  domain: string;
  source: LessonSource;
  cue: string;
  lesson: string;
  evidence: string;
  confidence: Confidence;
  sourceRef: string;
  uses: number;
  createdAt: string;
  lastUsedAt?: string;
  disabled?: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  return data;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function listLessons(filter: { agentId?: string | null; domain?: string } = {}): Promise<{ data: Lesson[] }> {
  const params = new URLSearchParams();
  if (filter.agentId) params.set('agentId', filter.agentId);
  if (filter.domain) params.set('domain', filter.domain);
  const qs = params.toString();
  return request<{ data: Lesson[] }>(`/api/learning/lessons${qs ? `?${qs}` : ''}`);
}

export function setLessonDisabled(id: string, disabled: boolean): Promise<{ data: Lesson }> {
  return request<{ data: Lesson }>(`/api/learning/lessons/${encodeURIComponent(id)}`, jsonInit('PATCH', { disabled }));
}

export async function deleteLesson(id: string): Promise<void> {
  const headers = await getApiHeaders();
  const res = await fetch(`${getApiBase()}/api/learning/lessons/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  }
}
