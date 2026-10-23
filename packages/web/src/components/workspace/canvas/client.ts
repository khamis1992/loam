/**
 * Neo N2: the Canvas HTTP client.
 *
 * The graph is owned by the server (N1). This client only reads it and sends the
 * three edits the panel can make. Every call is injectable so the component tests
 * can run without a server, and every failure surfaces as a rejected promise the
 * panel turns into a notice rather than a crash.
 */
import type { CanvasGraphResponse, CanvasNode, CanvasNodePatch } from './types';
import { coerceCanvasGraphResponse } from './types';

export interface CanvasClientOptions {
  /** Loam server base; defaults to getLoamBase() (http://127.0.0.1:<port>). */
  apiBase?: string;
  /** Auth headers; defaults to the install token header. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Fetch implementation (injectable for tests). */
  fetchFn?: typeof fetch;
}

export class CanvasClient {
  private readonly apiBase: string;
  private readonly headers: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: CanvasClientOptions = {}) {
    // Kept as a field so tests can inject a base without touching the window.
    this.apiBase = options.apiBase ?? defaultApiBase();
    this.headers = options.headers;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** The whole graph for a run, plus the nodes appended after `afterSeq`. */
  async getGraph(runId: string, afterSeq = 0): Promise<CanvasGraphResponse> {
    const params = afterSeq > 0 ? `?afterSeq=${Math.floor(afterSeq)}` : '';
    const res = await this.request(`/api/graph/${encodeURIComponent(runId)}${params}`);
    const data = (await res.json()) as unknown;
    const parsed = coerceCanvasGraphResponse(data);
    if (!parsed) throw new Error('malformed canvas graph payload');
    return parsed;
  }

  /** Send one canvas edit (status, payload or parents) and return the new node. */
  async patchNode(runId: string, nodeId: string, patch: CanvasNodePatch): Promise<CanvasNode> {
    const res = await this.request(`/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = (await res.json().catch(() => ({}))) as { node?: unknown; error?: string };
    if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
    const node = data.node;
    if (!node || typeof node !== 'object') throw new Error('the server returned no node');
    return node as CanvasNode;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...(await this.resolveHeaders()), ...(init.headers as Record<string, string> | undefined) };
    return this.fetchFn(`${this.apiBase}${path}`, { ...init, headers });
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    return this.headers ? this.headers() : {};
  }
}

/** Resolve the Loam server base the same way the rest of the web app does. */
function defaultApiBase(): string {
  if (typeof window === 'undefined') return '';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { loamBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.loamBase) return injected.loamBase;
  const sync = (window as unknown as { desktopSync?: { env?: Record<string, string> } }).desktopSync;
  const port = sync?.env?.LOAM_PORT || sync?.env?.MANUS_LOCAL_PORT || '3939';
  return `http://127.0.0.1:${port}`;
}
