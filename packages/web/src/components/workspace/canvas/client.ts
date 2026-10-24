/**
 * Neo N2: the Canvas HTTP client.
 *
 * The graph is owned by the server (N1). This client only reads it and sends the
 * edits the panel can make. Every call is injectable so the component tests can
 * run without a server, and every failure surfaces as a rejected promise the
 * panel turns into a notice rather than a crash.
 */
import type {
  CanvasGraphResponse,
  CanvasGraphSearch,
  CanvasNode,
  CanvasNodePatch,
  CanvasOpRequest,
  CanvasOpResult,
} from './types';
import { CANVAS_NODE_TYPES, coerceCanvasGraphResponse, coerceCanvasOpResult } from './types';
import type {
  CanvasArtifactInfo,
  CanvasDiff,
  CanvasKnowledgePreview,
  CanvasKnowledgeResult,
  CanvasPreviewStart,
  CanvasVersion,
  CanvasVersionList,
} from './nodeActions';
import {
  coerceCanvasDiff,
  coerceCanvasKnowledgePreview,
  coerceCanvasVersionList,
} from './nodeActions';

/**
 * Node kinds that carry text the diff view and the Knowledge Garden can use.
 *
 * The server decides this too (`graph/nodeVersions.ts`), so the sheet must not
 * offer an action the server would refuse. `kb_seed` is a cited Knowledge Garden
 * seed, which is a document in its own right.
 */
const DOCUMENT_NODE_KINDS = new Set<string>(['document', 'webpage', 'kb_seed']);

/** True when the node kind can be versioned, diffed and pushed to the garden. */
export const canUseNodeActions = (type: unknown): boolean =>
  typeof type === 'string' && DOCUMENT_NODE_KINDS.has(type);

/** True when the node is a webpage, so it can be previewed and downloaded as a ZIP. */
export const canOpenWebpage = (type: unknown): boolean => type === 'webpage';

/** Node kinds the canvas can render, for callers that need the full list. */
export { CANVAS_NODE_TYPES };

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
    // Bound, not bare: this is called as a method, so a bare `fetch` would run with
    // `this` set to the client and throw "Illegal invocation" in a browser. Node's
    // fetch ignores its receiver, so only a real browser catches this.
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
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
   * Neo N18: search the *whole* run, not just the nodes this client holds.
   *
   * The panel keeps one snapshot, so a collapsed branch or a node the layout
   * dropped is invisible to a local search. The server scans every node it owns
   * and replies with the hits, which the panel highlights in one round. An
   * unreachable server is not an error: the caller falls back to its own nodes.
   */
  async searchGraph(runId: string, term: string): Promise<CanvasGraphSearch | null> {
    const query = encodeURIComponent(term.trim());
    if (!query) return null;
    const res = await this.request(`/api/graph/${encodeURIComponent(runId)}?q=${query}`);
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) return null;
    const parsed = coerceCanvasGraphResponse(data);
    return parsed?.search ?? null;
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

  /* ------------------------------------------------------------------ N13 ---- */

  /** Version history of a document/webpage node (oldest first). */
  async getNodeVersions(runId: string, nodeId: string): Promise<CanvasVersionList> {
    const data = await this.json<CanvasVersionList>(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/versions`,
    );
    const parsed = coerceCanvasVersionList(data);
    if (!parsed) throw new Error('malformed version payload');
    return parsed;
  }

  /** The line diff between two versions of a node (`to` defaults to the newest). */
  async getNodeDiff(runId: string, nodeId: string, from: number, to?: number): Promise<CanvasDiff> {
    const params = new URLSearchParams({ from: String(from) });
    if (to !== undefined) params.set('to', String(to));
    const data = await this.json<CanvasDiff>(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/diff?${params.toString()}`,
    );
    const parsed = coerceCanvasDiff(data);
    if (!parsed) throw new Error('malformed diff payload');
    return parsed;
  }

  /** Capture the node's current text as a new version (the canvas "save a snapshot"). */
  async captureNodeVersion(
    runId: string,
    nodeId: string,
    content?: string,
  ): Promise<{ ok: boolean; version: number; versions: CanvasVersion[] }> {
    return this.json(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/versions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(content === undefined ? {} : { content }),
      },
    );
  }

  /** How a node would be split into Knowledge Garden seeds, without writing them. */
  async previewNodeKnowledge(runId: string, nodeId: string): Promise<CanvasKnowledgePreview> {
    const data = await this.json<CanvasKnowledgePreview>(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/knowledge/preview`,
    );
    const parsed = coerceCanvasKnowledgePreview(data);
    if (!parsed) throw new Error('malformed knowledge preview payload');
    return parsed;
  }

  /** "Add to Knowledge Base": turn the node's text into seeds with node provenance. */
  async addToKnowledgeBase(
    runId: string,
    nodeId: string,
    input: { baseId?: string; tags?: string[]; split?: 'llm' | 'fixed' } = {},
  ): Promise<CanvasKnowledgeResult> {
    return this.json(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/knowledge`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  }

  /** Resolve a webpage node's artifact directory (the preview tab and ZIP target). */
  async getNodeArtifact(runId: string, nodeId: string): Promise<CanvasArtifactInfo> {
    return this.json(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/artifact`,
    );
  }

  /** Ask the server to serve a webpage node in the sandbox preview and return its URL. */
  async startNodePreview(runId: string, nodeId: string): Promise<CanvasPreviewStart> {
    return this.json(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/preview`,
    );
  }

  /**
   * The ZIP a webpage node downloads, as a Blob the caller can hand to the
   * browser. This is a raw byte read rather than JSON: the route replies with
   * `application/zip` and a `content-disposition`, so the client has to stay out
   * of the way and let the download be the server's.
   */
  async downloadNodeZip(runId: string, nodeId: string): Promise<Blob> {
    const res = await this.request(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/artifact.zip`,
    );
    if (res.ok) return res.blob();
    // A failed download is still a JSON reply from the route (404 no artifact,
    // 413 too large), so the server's own message is what the panel should show.
    const text = await res.text().catch(() => '');
    let message = '';
    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data.error === 'string') message = data.error;
    } catch {
      // Not JSON (a proxy error page, say): fall through to the status line.
    }
    if (!message) {
      const match = text.match(/<pre[^>]*>([^<]+)<\/pre>/);
      message = match?.[1]?.trim() ?? '';
    }
    throw new Error(message || `download failed (${res.status})`);
  }

  /** The Knowledge Garden bases, so the sheet can offer a target instead of a free-text name. */
  async listKnowledgeBases(): Promise<Array<{ id: string; name: string; seeds: number }>> {
    const data = await this.json<{ bases?: unknown }>(`/api/knowledge`);
    const bases = Array.isArray(data.bases) ? data.bases : [];
    return bases.flatMap((base) => {
      if (typeof base !== 'object' || base === null) return [];
      const b = base as Record<string, unknown>;
      if (typeof b.id !== 'string' || typeof b.name !== 'string') return [];
      return [{ id: b.id, name: b.name, seeds: typeof b.seeds === 'number' ? b.seeds : 0 }];
    });
  }

  /* ------------------------------------------------------------------ N11 ---- */

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

  /** GET/POST a JSON body and surface the server's own error message. */
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `request failed (${res.status})`);
    return data;
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