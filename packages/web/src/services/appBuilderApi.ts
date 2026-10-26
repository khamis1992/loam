import { getApiBase, getApiHeaders } from './rpc';

/** Client for the App Builder routes (`src/server/routes/appBuilder.ts`, Cap G §4.15.2).
 *  Mirrors the server envelope: `{ <resource> }` on success, `{ error }` on failure.
 *  Keys are never returned by the AI routes (hasKey / keySource only). */

export type AppRunFlavor = 'quick' | 'goal';

export interface AppProjectDto {
  id: string;
  taskId: string;
  title: string;
  description: string;
  templateId: string;
  features: string[];
  workspaceDir: string;
  appDir: string;
  defaultFlavor: AppRunFlavor;
  status: string;
  activeVersion: number | null;
  settings: Record<string, unknown> & { raceBranches?: number };
  remixOfProjectId: string | null;
  remixOfVersion: number | null;
  depsMode: string;
  ai: { baseUrl: string | null; model: string | null; dailyTokenCap: number | null };
  createdAt: string;
  updatedAt: string;
}

export interface PromptQueueItemDto {
  id: string;
  projectId: string;
  position: number;
  content: string;
  flavor: AppRunFlavor;
  attachments: string[];
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export interface PromptQueueStateDto {
  projectId: string;
  paused: boolean;
  items: PromptQueueItemDto[];
}

export interface RaceEstimateDto {
  branches: 2 | 3 | 4;
  perRunCredits: number;
  extraCredits: number;
  maxTotalCredits: number;
  basis: 'history' | 'default';
  sampleRuns: number;
}

export interface AppAiProviderPublicDto {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface AppAiProjectConfigDto {
  keySource: 'project' | 'default' | 'none';
  effective: AppAiProviderPublicDto;
  dailyTokenCap: number | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? `${data.error}${data.message ? `: ${data.message}` : ''}` : `status ${res.status}`);
  return data;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const listAppProjects = (limit = 50) => request<{ projects: AppProjectDto[] }>(`/api/app-projects?limit=${limit}`);
export const createAppProject = (title: string, description?: string, flavor?: AppRunFlavor) =>
  request<{ project: AppProjectDto }>('/api/app-projects', json({ title, description, flavor }));
export const getAppProject = (id: string) =>
  request<{ project: AppProjectDto; devServer: unknown; queue: PromptQueueStateDto }>(`/api/app-projects/${id}`);
export const patchAppProject = (id: string, patch: { title?: string; description?: string }) =>
  request<{ project: AppProjectDto }>(`/api/app-projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
export const deleteAppProject = (id: string, confirmTitle: string) =>
  request<{ ok: true }>(`/api/app-projects/${id}`, json({ confirm: confirmTitle }));

export const appPreflight = () => request<{ preflight: { ok: boolean; items: Array<{ id: string; ok: boolean; detail?: string }>; checkedAt: string } }>('/api/app-projects/preflight');

export const getQueue = (id: string) => request<{ queue: PromptQueueStateDto }>(`/api/app-projects/${id}/queue`);
export const enqueue = (id: string, content: string, flavor: AppRunFlavor = 'quick', attachments: string[] = []) =>
  request<{ item: PromptQueueItemDto }>(`/api/app-projects/${id}/queue`, json({ content, flavor, attachments }));
export const updateQueueItem = (id: string, itemId: string, patch: { content?: string; position?: number }) =>
  request<{ queue: PromptQueueStateDto }>(`/api/app-projects/${id}/queue/${itemId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
export const removeQueueItem = (id: string, itemId: string) =>
  request<{ queue: PromptQueueStateDto }>(`/api/app-projects/${id}/queue/${itemId}`, { method: 'DELETE' });
export const pauseQueue = (id: string) => request<{ queue: PromptQueueStateDto }>(`/api/app-projects/${id}/queue/pause`, json({}));
export const resumeQueue = (id: string) => request<{ queue: PromptQueueStateDto }>(`/api/app-projects/${id}/queue/resume`, json({}));

export const raceEstimate = (id: string, branches: 2 | 3 | 4) =>
  request<{ estimate: RaceEstimateDto }>(`/api/app-projects/${id}/races/estimate?branches=${branches}`);

export const getAppUsage = (id: string, runId?: string) =>
  request<{ rows: Array<Record<string, unknown>>; totals: Record<string, number> }>(`/api/app-projects/${id}/usage${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);

export const getDefaultAi = () => request<{ provider: AppAiProviderPublicDto }>('/api/app-projects/ai-default');
export const putDefaultAi = (body: { baseUrl?: string; model?: string; key?: string }) =>
  request<{ provider: AppAiProviderPublicDto }>('/api/app-projects/ai-default', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const getProjectAi = (id: string) => request<{ config: AppAiProjectConfigDto }>(`/api/app-projects/${id}/ai`);
export const putProjectAi = (id: string, body: { baseUrl?: string | null; model?: string | null; key?: string; dailyTokenCap?: number | null }) =>
  request<{ config: AppAiProjectConfigDto }>(`/api/app-projects/${id}/ai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const testProjectAi = (id: string) => request<{ ok: boolean; status: number | null; error?: string }>(`/api/app-projects/${id}/ai/test`, json({}));

export const listFiles = (id: string) => request<{ files: string[]; truncated: boolean }>(`/api/app-projects/${id}/files`);
export const readFile = (id: string, path: string) =>
  request<{ content: string; sha1: string }>(`/api/app-projects/${id}/files/view?path=${encodeURIComponent(path)}`);
export const writeFile = (id: string, path: string, content: string, baseSha1?: string) =>
  request<{ sha1: string }>(`/api/app-projects/${id}/files`, json({ path, content, baseSha1 }));
