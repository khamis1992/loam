import { getApiBase, getApiHeaders } from './rpc';
import type { McpRuntimeStatus } from './mcpServersApi';

export interface ServicePack {
  id: string;
  title: string;
  category: string;
  description: string;
  capabilities: string[];
  platforms: string[];
  installed: Array<{ name: string; runtime: McpRuntimeStatus }>;
}

export interface ServicePackInstall {
  command?: string;
  transport?: 'stdio' | 'http';
  url?: string;
  accountName?: string;
  customInstructions?: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { ...(await getApiHeaders()), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
  return body as T;
}

export function listServicePacks(): Promise<{ packs: ServicePack[] }> {
  return request<{ packs: ServicePack[] }>('/api/service-packs');
}

export function installServicePack(id: string, name: string, config: ServicePackInstall): Promise<{ server: { name: string; runtime: McpRuntimeStatus } }> {
  return request<{ server: { name: string; runtime: McpRuntimeStatus } }>('/api/service-packs', {
    method: 'POST',
    body: JSON.stringify({ id, name, config }),
  });
}
