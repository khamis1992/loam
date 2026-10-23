import { getApiBase, getApiHeaders } from './rpc';

/**
 * Client for the Knowledge Garden surface (Neo N3).
 *
 * Talks to the `/api/knowledge` routes in the Loam server, which read and write
 * the same store the agent's `kb_*` tools use. That is deliberate: the garden
 * shown here is exactly what the model can retrieve, so the settings page is a
 * truthful view of the agent's knowledge rather than a parallel copy.
 */

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  seeds: number;
}

export interface KnowledgeSeedSummary {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  provenance?: { source: string; ref?: string; runId?: string; split?: string };
  smartSplit?: boolean;
}

export interface KnowledgeSeedInput {
  title?: string;
  body: string;
  tags?: string[];
}

export interface KnowledgeImportInput {
  /** Exactly one of text / path / url. */
  text?: string;
  path?: string;
  url?: string;
  tags?: string[];
  /** 'llm' (smart, falls back to fixed) or 'fixed'. */
  mode?: 'llm' | 'fixed';
  /** Used only when the target base does not exist yet. */
  baseName?: string;
}

export interface KnowledgeSearchHit {
  seedId: string;
  baseId: string;
  title: string;
  preview: string;
  tags: string[];
  score: number;
  lexical: number;
  vector: number | null;
  matched: string[];
}

export interface KnowledgeSearchResult {
  query: string;
  mode: 'lexical' | 'hybrid';
  empty: boolean;
  hits: KnowledgeSearchHit[];
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

export function listKnowledgeBases(): Promise<{ bases: KnowledgeBaseSummary[]; enabled: boolean }> {
  return request<{ bases: KnowledgeBaseSummary[]; enabled: boolean }>('/api/knowledge');
}

export function createKnowledgeBase(name: string, description?: string): Promise<{ base: KnowledgeBaseSummary }> {
  return request<{ base: KnowledgeBaseSummary }>('/api/knowledge', jsonInit('POST', { name, description }));
}

export function updateKnowledgeBase(
  baseId: string,
  patch: { name?: string; description?: string },
): Promise<{ base: KnowledgeBaseSummary }> {
  return request<{ base: KnowledgeBaseSummary }>(`/api/knowledge/${encodeURIComponent(baseId)}`, jsonInit('PUT', patch));
}

export function deleteKnowledgeBase(baseId: string): Promise<{ ok: boolean; baseId: string }> {
  return request<{ ok: boolean; baseId: string }>(`/api/knowledge/${encodeURIComponent(baseId)}`, { method: 'DELETE' });
}

export function getKnowledgeBase(baseId: string): Promise<{ base: KnowledgeBaseSummary; seeds: KnowledgeSeedSummary[] }> {
  return request<{ base: KnowledgeBaseSummary; seeds: KnowledgeSeedSummary[] }>(`/api/knowledge/${encodeURIComponent(baseId)}`);
}

export function ingestKnowledge(
  baseId: string,
  input: KnowledgeImportInput,
): Promise<{ ok: boolean; baseId: string; baseName: string; smartSplit: boolean; seeds: KnowledgeSeedSummary[]; warnings: string[] }> {
  return request(`/api/knowledge/${encodeURIComponent(baseId)}/ingest`, jsonInit('POST', input));
}

export function addKnowledgeSeed(baseId: string, input: KnowledgeSeedInput): Promise<{ seed: KnowledgeSeedSummary }> {
  return request<{ seed: KnowledgeSeedSummary }>(`/api/knowledge/${encodeURIComponent(baseId)}/seeds`, jsonInit('POST', input));
}

export function retagKnowledgeSeed(baseId: string, seedId: string, tags: string[]): Promise<{ seed: KnowledgeSeedSummary }> {
  return request<{ seed: KnowledgeSeedSummary }>(`/api/knowledge/${encodeURIComponent(baseId)}/seeds/${encodeURIComponent(seedId)}`, jsonInit('PUT', { tags }));
}

export function deleteKnowledgeSeed(baseId: string, seedId: string): Promise<{ ok: boolean; seedId: string }> {
  return request<{ ok: boolean; seedId: string }>(`/api/knowledge/${encodeURIComponent(baseId)}/seeds/${encodeURIComponent(seedId)}`, { method: 'DELETE' });
}

export function searchKnowledge(query: string, baseId?: string, k = 8): Promise<KnowledgeSearchResult> {
  const params = new URLSearchParams({ query });
  if (baseId) params.set('baseId', baseId);
  params.set('k', String(k));
  return request<KnowledgeSearchResult>(`/api/knowledge/search?${params.toString()}`);
}
