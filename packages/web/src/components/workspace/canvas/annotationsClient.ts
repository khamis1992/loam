/**
 * Neo N18: the Canvas annotation HTTP client.
 *
 * Annotations are the user's layer over the agent graph (N18). The client only
 * reads and writes that layer: the graph itself stays with `CanvasClient`. Every
 * call is injectable so the component tests run without a server, and every
 * failure surfaces as a rejected promise the panel turns into a notice.
 */
import type {
  CanvasAnnotations,
  CanvasColourPatch,
  CanvasComment,
  CanvasCommentDraft,
  CanvasFreeNote,
  CanvasNoteDraft,
  CanvasNotePatch,
} from './types.annotations';
import { coerceCanvasAnnotations } from './types.annotations';

export interface CanvasAnnotationsClientOptions {
  /** Loam server base; defaults to getLoamBase() (http://127.0.0.1:<port>). */
  apiBase?: string;
  /** Auth headers; defaults to the install token header. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Fetch implementation (injectable for tests). */
  fetchFn?: typeof fetch;
}

export class CanvasAnnotationsClient {
  private readonly apiBase: string;
  private readonly headers: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: CanvasAnnotationsClientOptions = {}) {
    // Kept as a field so tests can inject a base without touching the window.
    this.apiBase = options.apiBase ?? defaultApiBase();
    this.headers = options.headers;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** The whole annotation layer of a run. */
  async getAnnotations(runId: string): Promise<CanvasAnnotations> {
    const res = await this.request(`/api/graph/${encodeURIComponent(runId)}/annotations`);
    const data = (await res.json()) as unknown;
    const parsed = coerceCanvasAnnotations(data);
    if (!parsed) throw new Error('malformed canvas annotation payload');
    return parsed;
  }

  /** Set (or clear, with "none") one node's colour tag. */
  async setColour(runId: string, nodeId: string, patch: CanvasColourPatch): Promise<void> {
    await this.mutate(`/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/colour`, 'PATCH', patch);
  }

  /** Append one comment to a node's thread. */
  async addComment(runId: string, nodeId: string, draft: CanvasCommentDraft): Promise<CanvasComment> {
    const data = (await this.mutate(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/comments`,
      'POST',
      draft,
    )) as { comment?: unknown };
    const comment = data.comment;
    if (!comment || typeof comment !== 'object') throw new Error('the server returned no comment');
    return comment as CanvasComment;
  }

  /** Remove one comment from a node's thread. */
  async removeComment(runId: string, nodeId: string, commentId: string): Promise<void> {
    await this.mutate(
      `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/comments/${encodeURIComponent(commentId)}`,
      'DELETE',
    );
  }

  /** Create a free note on the canvas surface. */
  async addNote(runId: string, draft: CanvasNoteDraft): Promise<CanvasFreeNote> {
    const data = (await this.mutate(`/api/graph/${encodeURIComponent(runId)}/notes`, 'POST', draft)) as {
      note?: unknown;
    };
    const note = data.note;
    if (!note || typeof note !== 'object') throw new Error('the server returned no note');
    return note as CanvasFreeNote;
  }

  /** Move and/or edit a free note. */
  async updateNote(runId: string, noteId: string, patch: CanvasNotePatch): Promise<CanvasFreeNote> {
    const data = (await this.mutate(
      `/api/graph/${encodeURIComponent(runId)}/notes/${encodeURIComponent(noteId)}`,
      'PATCH',
      patch,
    )) as { note?: unknown };
    const note = data.note;
    if (!note || typeof note !== 'object') throw new Error('the server returned no note');
    return note as CanvasFreeNote;
  }

  /** Delete a free note. */
  async removeNote(runId: string, noteId: string): Promise<void> {
    await this.mutate(`/api/graph/${encodeURIComponent(runId)}/notes/${encodeURIComponent(noteId)}`, 'DELETE');
  }

  private async mutate(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<unknown> {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    // A DELETE carries no body; sending an empty one is rejected by some servers.
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.request(path, init);
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `annotation save failed (${res.status})`);
    return data;
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
