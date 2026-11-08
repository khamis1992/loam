import type { BuildSelection, ExportKind } from '@shared/buildMenu';
import { getApiBase, getApiHeaders } from './rpc';

export interface PreparedBuild {
  projectId: string;
  revision: number;
  jobId: string;
  engine: string;
  summary: string;
  previewHtml?: string;
  previewUrl?: string;
  previewNonce?: string;
  artifactId?: string;
  phase?: string;
  message?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? data.error ?? `status ${res.status}`);
  return data;
}

export async function readBuildMenuEnabled(): Promise<boolean> {
  const res = await fetch(`${getApiBase()}/api/build-menu/capabilities`, { headers: await getApiHeaders() });
  if (!res.ok) return false;
  const data = (await res.json()) as { enabled?: boolean };
  return data.enabled === true;
}

async function planDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareBuildProject(input: {
  title: string;
  brief: string;
  selection: BuildSelection;
}): Promise<PreparedBuild> {
  const created = await postJson<{ projectId: string; revision: number }>('/api/build-menu/projects', input);
  const planSha256 = await planDigest(`${input.title}\n${input.brief}`);
  const grant = await postJson<{ grantId: string }>(`/api/build-menu/projects/${created.projectId}/grants`, {
    expectedRevision: created.revision,
    planSha256,
    operation: { action: 'generate' },
  });
  return postJson<PreparedBuild>(`/api/build-menu/projects/${created.projectId}/jobs`, {
    expectedRevision: created.revision,
    planSha256,
    operation: { action: 'generate' },
    grantId: grant.grantId,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function previewBuildProject(input: {
  projectId: string;
  revision: number;
  title: string;
  brief: string;
}): Promise<PreparedBuild> {
  const planSha256 = await planDigest(`${input.title}\n${input.brief}`);
  const grant = await postJson<{ grantId: string }>(`/api/build-menu/projects/${input.projectId}/grants`, {
    expectedRevision: input.revision,
    planSha256,
    operation: { action: 'preview' },
  });
  return postJson<PreparedBuild>(`/api/build-menu/projects/${input.projectId}/jobs`, {
    expectedRevision: input.revision,
    planSha256,
    operation: { action: 'preview' },
    grantId: grant.grantId,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function packageBuildProject(input: {
  projectId: string;
  revision: number;
  title: string;
  brief: string;
  format?: ExportKind;
}): Promise<PreparedBuild> {
  const format = input.format ?? 'source-zip';
  const planSha256 = await planDigest(`${input.title}\n${input.brief}`);
  const operation = { action: 'package' as const, format };
  const grant = await postJson<{ grantId: string }>(`/api/build-menu/projects/${input.projectId}/grants`, {
    expectedRevision: input.revision,
    planSha256,
    operation,
  });
  return postJson<PreparedBuild>(`/api/build-menu/projects/${input.projectId}/jobs`, {
    expectedRevision: input.revision,
    planSha256,
    operation,
    grantId: grant.grantId,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function readBuildJob(projectId: string, jobId: string): Promise<{ phase: string; message?: string; jobId?: string; revision?: number }> {
  const res = await fetch(`${getApiBase()}/api/build-menu/projects/${projectId}/jobs/${jobId}`, { method: 'GET', headers: await getApiHeaders() });
  const data = (await res.json().catch(() => ({}))) as { phase?: string; message?: string; error?: string; jobId?: string; revision?: number };
  if (!res.ok || typeof data.phase !== 'string') throw new Error(data.error ?? 'status');
  return {
    phase: data.phase,
    message: data.message,
    jobId: typeof data.jobId === 'string' ? data.jobId : undefined,
    revision: typeof data.revision === 'number' ? data.revision : undefined,
  };
}

export async function cancelBuildJob(projectId: string, jobId: string): Promise<void> {
  await postJson(`/api/build-menu/projects/${projectId}/jobs/${jobId}/cancel`, {});
}

export async function activateBuildRoutine(projectId: string): Promise<{ enabled: boolean }> {
  return postJson(`/api/build-menu/projects/${projectId}/routines/activate`, {});
}

export async function disableBuildRoutine(projectId: string): Promise<{ enabled: boolean }> {
  return postJson(`/api/build-menu/projects/${projectId}/routines/disable`, {});
}

export async function pauseBuildRoutine(projectId: string): Promise<{ enabled: boolean; paused: boolean }> {
  return postJson(`/api/build-menu/projects/${projectId}/routines/pause`, {});
}

export async function resumeBuildRoutine(projectId: string): Promise<{ enabled: boolean; paused: boolean }> {
  return postJson(`/api/build-menu/projects/${projectId}/routines/resume`, {});
}

