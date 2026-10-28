import { getApiBase, getLoamAuthHeaders } from '@/services/rpc';
import type { ArtifactRef } from './officeIntelligenceApi';

export type ConnectorType = 'rest-json' | 'sqlite' | 'webdav';

/** Mirrors `OfficeScope` in src/office/intelligence/contracts.ts. */
export interface OfficeConnectorScope {
  tenantId: string;
  projectId?: string;
  matterId?: string;
}

/** Mirrors `OfficeConnector` in src/office/intelligence/connectors.ts. */
export interface OfficeConnector {
  id: string;
  scope: OfficeConnectorScope;
  name: string;
  type: ConnectorType;
  config: {
    url?: string;
    dataPath?: string;
    bearerSecretName?: string;
    databasePath?: string;
    query?: string;
    baseUrl?: string;
    username?: string;
    passwordSecretName?: string;
    remotePath?: string;
    format?: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** Result of POST /api/office/connectors/:id/test — the rows a connector yields. */
export interface ConnectorRows {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
  syncedAt: string;
}

export interface ConnectorCreateInput {
  name: string;
  type: ConnectorType;
  config: {
    url?: string;
    dataPath?: string;
    bearerSecretName?: string;
    databasePath?: string;
    query?: string;
    baseUrl?: string;
    username?: string;
    passwordSecretName?: string;
    remotePath?: string;
    format?: string;
  };
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

export async function listOfficeConnectors(): Promise<OfficeConnector[]> {
  return (await request<{ connectors: OfficeConnector[] }>('/api/office/connectors?tenantId=local')).connectors;
}

export async function createOfficeConnector(input: ConnectorCreateInput): Promise<OfficeConnector> {
  return (await request<{ connector: OfficeConnector }>('/api/office/connectors', {
    method: 'POST',
    body: JSON.stringify({ scope: { tenantId: 'local' }, name: input.name, type: input.type, config: input.config }),
  })).connector;
}

/**
 * Run the connector once without writing anything. SQLite connectors resolve
 * their database inside the task workspace, so the server requires `taskId`
 * (it reads it from the query string, not the body).
 */
export async function testOfficeConnector(id: string, taskId: string): Promise<ConnectorRows> {
  return request<ConnectorRows>(`/api/office/connectors/${encodeURIComponent(id)}/test?taskId=${encodeURIComponent(taskId)}`, { method: 'POST', body: '{}' });
}

/** Sync the connector rows into the `Data` sheet of the target .xlsx artifact. */
export async function syncOfficeConnectorToSheet(id: string, taskId: string, path: string): Promise<ArtifactRef> {
  return (await request<{ artifact: ArtifactRef }>(`/api/office/connectors/${encodeURIComponent(id)}/sync`, {
    method: 'POST',
    body: JSON.stringify({ taskId, path }),
  })).artifact;
}

export async function deleteOfficeConnector(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/office/connectors/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
