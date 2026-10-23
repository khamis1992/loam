/**
 * fc-06 — Loam Video panel's Export button (web half).
 *
 * The render itself runs in the Node server (src/server/videoStudioExport.ts):
 * the panel POSTs the request, the server drives the editor through the relay,
 * reads the rendered bytes back and writes them into the task workspace. This
 * module only owns the browser side: sending the request and streaming the
 * progress events the server publishes on the task's SSE stream.
 */

import { getLoamAuthHeaders, getLoamBase } from '@/services/rpc';

export type LoamVideoExportStage = 'starting' | 'rendering' | 'saving';

export interface LoamVideoExportResult {
  ok: true;
  /** Path relative to the task workspace (exports/<name>). */
  path: string;
  name: string;
  mime: string;
  bytes: number;
  command: string;
}

export interface LoamVideoExportOptions {
  format?: string;
  name?: string;
  width?: number;
  height?: number;
  quality?: 'low' | 'medium' | 'high' | 'best';
  bitrateKbps?: number;
  range?: 'entire' | 'inOut' | 'workArea' | 'custom';
  startSeconds?: number;
  endSeconds?: number;
}

export interface LoamVideoExportProgress {
  stage: LoamVideoExportStage;
  progress?: number;
}

export interface ExportVideoOptions {
  taskId: string;
  options?: LoamVideoExportOptions;
  /** Progress callback driven by the task's live event stream. */
  onProgress?: (progress: LoamVideoExportProgress) => void;
  /** Fetch implementation (injectable for tests). */
  fetchFn?: typeof fetch;
  /** Loam server base; defaults to getLoamBase(). */
  apiBase?: string;
  /** Reuse an existing stream connection instead of opening one (default true). */
  useStream?: boolean;
}

/** Read one SSE frame's `data:` payload. */
function readFrameData(frame: string): string | null {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload.startsWith(':')) continue;
    return payload;
  }
  return null;
}

/**
 * Subscribe to a task's event stream and forward every export progress event to
 * `onProgress`. Resolves when the POST settles (the stream is left open for the
 * caller to close via the returned handle).
 */
async function watchExportProgress(
  fetchFn: typeof fetch,
  apiBase: string,
  taskId: string,
  onProgress: ((progress: LoamVideoExportProgress) => void) | undefined,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetchFn(`${apiBase}/api/tasks/${encodeURIComponent(taskId)}/stream`, {
    headers: { ...getLoamAuthHeaders(), accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const payload = readFrameData(frame);
        if (!payload) continue;
        let event: { type?: unknown; stage?: unknown; progress?: unknown };
        try {
          event = JSON.parse(payload) as typeof event;
        } catch {
          continue;
        }
        if (event.type !== 'video_studio_export' || typeof event.stage !== 'string') continue;
        onProgress?.({
          stage: event.stage as LoamVideoExportStage,
          ...(typeof event.progress === 'number' ? { progress: event.progress } : {}),
        });
      }
    }
  } catch {
    /* an aborted or closed stream is normal: the POST result is authoritative */
  }
}

/**
 * Ask the server to render the Loam Video timeline and save it into the task's
 * files. Resolves with the saved path/name/mime once the file is written.
 */
export async function exportLoamVideo(options: ExportVideoOptions): Promise<LoamVideoExportResult> {
  const { taskId, options: exportOptions, onProgress } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const apiBase = options.apiBase ?? getLoamBase();
  const controller = new AbortController();

  const watch = options.useStream === false
    ? Promise.resolve()
    : watchExportProgress(fetchFn, apiBase, taskId, onProgress, controller.signal).catch(() => {
        /* progress is best-effort: the POST result decides success */
      });

  let res: Response;
  try {
    res = await fetchFn(`${apiBase}/api/tasks/${encodeURIComponent(taskId)}/video-studio/export`, {
      method: 'POST',
      headers: { ...getLoamAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ options: exportOptions ?? {} }),
    });
  } catch (error) {
    controller.abort();
    throw error;
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    body = null;
  }

  if (!res.ok) {
    controller.abort();
    const detail =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `the Loam Video export failed (HTTP ${res.status})`;
    throw new Error(detail);
  }

  await watch;
  controller.abort();
  return body as LoamVideoExportResult;
}
