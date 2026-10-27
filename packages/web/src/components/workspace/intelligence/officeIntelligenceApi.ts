import { getApiBase, getLoamAuthHeaders } from '@/services/rpc';
import type { WorkspaceFile } from '../types';

export type ArtifactKind = 'document' | 'spreadsheet' | 'presentation';

export interface ArtifactRef {
  taskId: string;
  path: string;
  kind: ArtifactKind;
  revision: number;
  contentHash: string;
  tenantId: string;
}

export interface SourceAnchor {
  id: string;
  artifact: ArtifactRef;
  kind: string;
  anchor: string;
  excerpt: string;
  contentHash: string;
}

export interface ChangeSet {
  id: string;
  expectedRevision: number;
  preview: string[];
  destructive: boolean;
}

export interface OfficeRun {
  id: string;
  capability: string;
  artifact: ArtifactRef;
  instruction: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    summary: string;
    content?: string;
    citations: SourceAnchor[];
    warnings: string[];
    data?: unknown;
    changeSet?: ChangeSet;
  };
}

export function artifactKind(file: WorkspaceFile): ArtifactKind {
  if (file.kind === 'doc') return 'document';
  if (file.kind === 'sheet') return 'spreadsheet';
  if (file.kind === 'slides') return 'presentation';
  throw new Error('This workspace file does not support Office intelligence');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...getLoamAuthHeaders(), ...(init?.headers ?? {}) },
  });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

export async function describeOfficeArtifact(file: WorkspaceFile): Promise<ArtifactRef> {
  const data = await request<{ artifact: ArtifactRef }>('/api/office/intelligence/artifacts/describe', {
    method: 'POST',
    body: JSON.stringify({ taskId: file.taskId, path: file.path, kind: artifactKind(file), scope: { tenantId: 'local' } }),
  });
  return data.artifact;
}

export async function startOfficeRun(file: WorkspaceFile, capability: string, instruction: string): Promise<OfficeRun> {
  const artifact = await describeOfficeArtifact(file);
  const data = await request<{ run: OfficeRun }>('/api/office/intelligence/runs', {
    method: 'POST',
    body: JSON.stringify({ capability, artifact, instruction, scope: { tenantId: 'local' } }),
  });
  return data.run;
}

export async function getOfficeRun(id: string): Promise<OfficeRun> {
  const data = await request<{ run: OfficeRun }>(`/api/office/intelligence/runs/${encodeURIComponent(id)}`);
  return data.run;
}

export async function cancelOfficeRun(id: string): Promise<OfficeRun> {
  const data = await request<{ run: OfficeRun }>(`/api/office/intelligence/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
  return data.run;
}

export async function applyOfficeRun(id: string): Promise<void> {
  await request(`/api/office/intelligence/runs/${encodeURIComponent(id)}/apply`, { method: 'POST', body: '{}' });
}
