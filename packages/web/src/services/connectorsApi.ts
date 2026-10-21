import { getApiBase, getApiHeaders } from './rpc';

/** A connector as reported by GET /api/connectors. */
export interface OAuthConnector {
  id: string;
  name: string;
  configured: boolean;
  connected: boolean;
  account: string | null;
  envVars: string[];
}

export interface ConnectorListResponse {
  connectors: OAuthConnector[];
}

export interface ConnectorConnectResponse {
  authUrl?: string;
  error?: string;
}

interface ErrorBody {
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as ErrorBody).error || `${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

/** List the OAuth connectors and their connected/configured state. */
export function listConnectors(): Promise<ConnectorListResponse> {
  return request<ConnectorListResponse>('/api/connectors');
}

/**
 * Start the OAuth handshake for a connector. Returns the provider auth URL the
 * caller opens in a new tab. Throws when the connector is not configured.
 */
export function connectConnector(id: string): Promise<ConnectorConnectResponse> {
  return request<ConnectorConnectResponse>(`/api/connectors/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

/** Revoke a connector's stored tokens and mark it disconnected. */
export function disconnectConnector(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/connectors/${encodeURIComponent(id)}/disconnect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}
