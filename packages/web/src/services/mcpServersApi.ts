import { getApiBase, getApiHeaders } from './rpc';

export interface McpServerConfig {
  command?: string;
  transport?: 'stdio' | 'http';
  url?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  lazy?: boolean;
  sandbox?: boolean;
  accountName?: string;
  customInstructions?: string;
  disabledTools?: string[];
}

export interface McpRuntimeStatus {
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface McpServer extends McpServerConfig {
  name: string;
  headerNames: string[];
  envNames: string[];
  runtime: McpRuntimeStatus;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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

export function listMcpServers(): Promise<{ servers: McpServer[] }> {
  return request<{ servers: McpServer[] }>('/api/mcp/servers');
}

export function createMcpServer(name: string, config: McpServerConfig): Promise<{ server: McpServer }> {
  return request<{ server: McpServer }>('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ name, config }) });
}

export function updateMcpServer(name: string, config: McpServerConfig): Promise<{ server: McpServer }> {
  return request<{ server: McpServer }>(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ config }) });
}

export function deleteMcpServer(name: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function listMcpServerTools(name: string): Promise<{ tools: McpTool[]; disabledTools: string[] }> {
  return request<{ tools: McpTool[]; disabledTools: string[] }>(`/api/mcp/servers/${encodeURIComponent(name)}/tools`);
}

export function setMcpServerDisabledTools(name: string, disabledTools: string[]): Promise<{ disabledTools: string[] }> {
  return request<{ disabledTools: string[] }>(`/api/mcp/servers/${encodeURIComponent(name)}/tools`, {
    method: 'PUT',
    body: JSON.stringify({ disabledTools }),
  });
}
