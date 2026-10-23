/**
 * fc-06 — the browser half of the Loam Video export (`exportLoamVideo`).
 *
 * The server service is covered by src/server/__tests__/videoStudioExport.test.ts;
 * the panel is covered by LoamVideoPanel.export.test.tsx (which mocks this
 * module). This file covers the contract that neither of those can see: the
 * request shape, the SSE progress stream parsing (including a frame split
 * across two network chunks), and how the server's error body is surfaced.
 */
import { describe, expect, it, vi } from 'vitest';
import { exportLoamVideo, type LoamVideoExportProgress } from './videoStudioExport';

const API = 'http://127.0.0.1:3939';

vi.mock('@/services/rpc', () => ({
  getLoamBase: () => API,
  getLoamAuthHeaders: () => ({ 'x-loam-local-token': 'tok' }),
}));

/** A Response whose body is the given SSE text (possibly split into chunks). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function exportFrame(stage: string, progress?: number): string {
  return `data: ${JSON.stringify({ type: 'video_studio_export', taskId: 'task-1', stage, ...(progress === undefined ? {} : { progress }) })}\n\n`;
}

/** Builds a fetch that serves the SSE stream and records the export request. */
function makeFetch(streamChunks: string[], postStatus = 200, postBody: unknown = {}) {
  const posted: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/stream')) return sseResponse(streamChunks);
    posted.push({ url: href, init });
    return new Response(JSON.stringify(postBody), {
      status: postStatus,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posted };
}

describe('exportLoamVideo', () => {
  it('posts the options to the export route and returns the saved file', async () => {
    const { fetchFn, posted } = makeFetch([], 200, {
      ok: true,
      path: 'exports/loam-cut.mp4',
      name: 'loam-cut.mp4',
      mime: 'video/mp4',
      bytes: 1234,
      command: 'file.exportMedia',
    });

    const result = await exportLoamVideo({
      taskId: 'task-1',
      options: { format: 'mp4', name: 'loam-cut', quality: 'high' },
      fetchFn,
    });

    expect(result).toEqual({
      ok: true,
      path: 'exports/loam-cut.mp4',
      name: 'loam-cut.mp4',
      mime: 'video/mp4',
      bytes: 1234,
      command: 'file.exportMedia',
    });

    // Exactly one export request, on the right route, with the options body.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`${API}/api/tasks/task-1/video-studio/export`);
    expect(posted[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(posted[0]?.init?.body))).toEqual({
      options: { format: 'mp4', name: 'loam-cut', quality: 'high' },
    });
    // The request carries the local auth header.
    expect(posted[0]?.init?.headers).toMatchObject({ 'x-loam-local-token': 'tok' });
  });

  it('forwards export progress from the SSE stream, reassembling split frames', async () => {
    const progress: LoamVideoExportProgress[] = [];
    // The `saving` frame is split across two network chunks: the parser must
    // buffer the partial frame instead of dropping it.
    const { fetchFn } = makeFetch(
      [`${exportFrame('starting')}${exportFrame('rendering', 0.4)}data: {"type":"video_studio_`, `export","taskId":"task-1","stage":"saving"}\n\n`],
      200,
      { ok: true, path: 'exports/a.mp4', name: 'a.mp4', mime: 'video/mp4', bytes: 3, command: 'file.exportMedia' },
    );

    await exportLoamVideo({ taskId: 'task-1', onProgress: (p) => progress.push(p), fetchFn });

    expect(progress).toEqual([
      { stage: 'starting' },
      { stage: 'rendering', progress: 0.4 },
      { stage: 'saving' },
    ]);
  });

  it('ignores unrelated stream events and keepalives', async () => {
    const progress: LoamVideoExportProgress[] = [];
    const { fetchFn } = makeFetch(
      [
        `data: ${JSON.stringify({ type: 'task-status', status: 'running' })}\n\n`,
        // A foreign event that happens to carry a `stage` field: only the type
        // filter keeps it out of the export progress.
        `data: ${JSON.stringify({ type: 'video_studio_command', stage: 'rendering', progress: 0.9 })}\n\n`,
        ': keepalive\n\n',
        exportFrame('starting'),
        'data: not json at all\n\n',
      ],
      200,
      { ok: true, path: 'exports/a.mp4', name: 'a.mp4', mime: 'video/mp4', bytes: 3, command: 'file.exportMedia' },
    );

    await exportLoamVideo({ taskId: 'task-1', onProgress: (p) => progress.push(p), fetchFn });

    expect(progress).toEqual([{ stage: 'starting' }]);
  });

  it("surfaces the server's own error message on a failed export", async () => {
    const { fetchFn } = makeFetch([], 502, { ok: false, reason: 'export_failed', message: 'the render failed (encoder crashed)' });

    await expect(exportLoamVideo({ taskId: 'task-1', fetchFn })).rejects.toThrow('the render failed (encoder crashed)');
  });

  it('falls back to the HTTP status when the error body carries no message', async () => {
    const { fetchFn } = makeFetch([], 504, {});

    await expect(exportLoamVideo({ taskId: 'task-1', fetchFn })).rejects.toThrow('HTTP 504');
  });

  it('rejects a transport failure without reaching the server', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(exportLoamVideo({ taskId: 'task-1', fetchFn })).rejects.toThrow('network down');
  });

  it('still resolves when the stream cannot be read (the POST result is authoritative)', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/stream')) {
        // A stream that ends immediately: nothing to forward, but not fatal.
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, path: 'exports/a.mp4', name: 'a.mp4', mime: 'video/mp4', bytes: 1, command: 'file.exportMedia' }), { status: 200 });
    }) as unknown as typeof fetch;

    const progress: LoamVideoExportProgress[] = [];
    const result = await exportLoamVideo({ taskId: 'task-1', onProgress: (p) => progress.push(p), fetchFn });

    expect(result.ok).toBe(true);
    expect(progress).toEqual([]);
  });
});
