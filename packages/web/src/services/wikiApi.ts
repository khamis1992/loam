import { getApiBase, getApiHeaders } from './rpc';

/**
 * Client for the per-project wiki and handoff routes
 * (`src/server/routes/projectWiki.ts`). The wiki is off by default; every
 * route except `status` answers 409 until it is switched on.
 */

export type WikiKind = 'session' | 'lesson' | 'note' | 'handoff';
export type HandoffState = 'open' | 'accepted' | 'dismissed';

export interface WikiPageMeta {
  kind: WikiKind;
  id: string;
  title: string;
  updatedAt?: string;
  tags?: string[];
}

export interface Handoff {
  id: string;
  title: string;
  state: HandoffState;
  createdAt?: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  return data;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const wikiStatus = () => request<{ enabled: boolean }>('/api/project-wiki/status');
export const setWikiEnabled = (enabled: boolean) =>
  request<{ enabled: boolean }>('/api/project-wiki/status', json('PUT', { enabled }));
export const listWikiPages = (kind?: WikiKind) =>
  request<{ pages: WikiPageMeta[] }>(`/api/project-wiki/pages${kind ? `?kind=${kind}` : ''}`);
export const listHandoffs = (state?: HandoffState) =>
  request<{ handoffs: Handoff[] }>(`/api/handoffs${state ? `?state=${state}` : ''}`);
export const resolveHandoff = (id: string, to: 'accepted' | 'dismissed') =>
  request<{ id: string; state: HandoffState }>(`/api/handoffs/${encodeURIComponent(id)}`, json('POST', { to }));
