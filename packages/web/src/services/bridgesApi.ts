import { getApiBase, getApiHeaders } from './rpc';

/** Client for the app bridge routes (`src/server/routes/bridges.ts`). */

export type BridgeStatus = 'ready' | 'disabled' | 'missing' | 'error';

export interface BridgeInfo {
  id: string;
  name: string;
  description: string;
  status: BridgeStatus;
  enabled: boolean;
  version?: string;
  detail?: string;
  commands: { id: string; description: string; effect: string }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  return data;
}

export const listBridges = () => request<{ bridges: BridgeInfo[] }>('/api/bridges');
export const setBridgeEnabled = (id: string, enabled: boolean) =>
  request<{ bridge: BridgeInfo }>(`/api/bridges/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
export const createBridgeSkill = (id: string) =>
  request<{ file: string }>(`/api/bridges/${encodeURIComponent(id)}/skill`, { method: 'POST' });
