/**
 * Neo N2: the Canvas HTTP client.
 *
 * The graph is owned by the server (N1). This client only reads it and sends the
 * edits the panel can make. Every call is injectable so the component tests can
 * run without a server, and every failure surfaces as a rejected promise the
 * panel turns into a notice rather than a crash.
 */
import type { CanvasGraphResponse, CanvasNode, CanvasNodePatch } from './types';
import { coerceCanvasGraphResponse } from './types';
import type { CanvasOpRequest, CanvasOpResult } from './types';
import { coerceCanvasOpResult } from './types';

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

  /**
   * Write one node field directly.
   *
   * This is the N2 escape hatch for a write that changes no content and therefore
   * supersedes nothing, such as a status flip or a parent re-point. Anything that
   * edits what a node *says* must go through `applyOp` instead, so the node gets a
   * version and the agent is told; the panel uses `applyOp` for every edit.
   */
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

  /**
   * Apply one N11 editing operation (edit, cut/re-connect, duplicate, group,
   * quote/follow-up) and return the run's whole graph plus what the op superseded.
   *
   * The whole graph comes back because several of these operations create or
   * re-point nodes, and the panel must not have to guess which ids appeared.
   */
  async applyOp(runId: string, op: CanvasOpRequest): Promise<CanvasOpResult> {
    const res = await this.request(`/api/graph/${encodeURIComponent(runId)}/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(op),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `canvas operation failed (${res.status})`);
    const parsed = coerceCanvasOpResult(data);
    if (!parsed) throw new Error('malformed canvas operation reply');
    return parsed;
  }

  /** The canvas edits this run has queued for the model but not consumed yet. */
  async getDirectives(runId: string): Promise<unknown[]> {
    const res = await this.request(`/api/graph/${encodeURIComponent(runId)}/ops`);
    const data = (await res.json().catch(() => ({}))) as { directives?: unknown };
    if (!res.ok) throw new Error('could not read the canvas edits for this run');
    const list = data.directives;
    return Array.isArray(list) ? list : [];
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
