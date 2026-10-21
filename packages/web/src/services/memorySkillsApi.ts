import { getApiBase, getApiHeaders } from './rpc';

/**
 * Client for the Settings › Skills surface (UNIMPLEMENTED_OPTIONS #4).
 *
 * Talks to the `/api/memory-skills` route in the Loam server, which proxies the
 * memory-skills MCP backend. Keeps the persistent skills the agent records
 * listable, editable and deletable from the settings page.
 */

export interface MemorySkillSummary {
  slug: string;
  name: string;
  description: string;
  version: number;
  uses: number;
  successes: number;
  failures: number;
  partials: number;
  successRate: number;
  lastUsed: string | null;
  updatedAt: string;
  tags: string[];
}

export interface MemorySkillDetail extends MemorySkillSummary {
  path: string;
  source: string;
  body: string;
}

export interface MemorySkillInput {
  name: string;
  description: string;
  body: string;
  tags?: string[];
}

export interface MemorySkillRecordResult {
  ok: boolean;
  slug: string;
  version: number;
  action: 'created' | 'updated';
  message: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  return data;
}

export function listMemorySkills(): Promise<{ skills: MemorySkillSummary[] }> {
  return request<{ skills: MemorySkillSummary[] }>('/api/memory-skills');
}

export function getMemorySkill(slug: string): Promise<MemorySkillDetail> {
  return request<MemorySkillDetail>(`/api/memory-skills/${encodeURIComponent(slug)}`);
}

export function createMemorySkill(input: MemorySkillInput): Promise<MemorySkillRecordResult> {
  return request<MemorySkillRecordResult>('/api/memory-skills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updateMemorySkill(slug: string, input: MemorySkillInput): Promise<MemorySkillRecordResult> {
  return request<MemorySkillRecordResult>(`/api/memory-skills/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteMemorySkill(slug: string): Promise<{ ok: boolean; slug: string }> {
  return request<{ ok: boolean; slug: string }>(`/api/memory-skills/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
}
