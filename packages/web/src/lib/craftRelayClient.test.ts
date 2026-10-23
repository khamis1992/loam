import { describe, expect, it, vi } from 'vitest';
import { CraftRelayClient, craftRelayExecutor, type CraftBridgeLike, type CraftRelayCommand } from './craftRelayClient';
import type { CraftBridge } from './craftBridge';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function craftFrame(id: string, method = 'engine.execute', params: Record<string, unknown> = {}, target = 'docs'): string {
  return `data: ${JSON.stringify({ type: 'workspace_command', id, taskId: 'task-1', target, method, params })}\n\n`;
}

function videoFrame(id: string): string {
  return `data: ${JSON.stringify({ type: 'video_studio_command', id, taskId: 'task-1', target: 'film', method: 'inspect', params: {} })}\n\n`;
}

/** A Craft bridge double that records what the relay does to the panel. */
function fakeBridge(handlers: { onExecute?: (command: string) => void } = {}) {
  const opened: Array<{ name: string; bytes: Uint8Array }> = [];
  const saveCallbacks = new Set<(save: { app: string; name: string; bytes: Uint8Array }) => void>();
  const bridge: CraftBridgeLike = {
    open: (name, bytes) => {
      opened.push({ name, bytes });
    },
    onSave: (cb) => {
      saveCallbacks.add(cb);
      return () => saveCallbacks.delete(cb);
    },
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'engine.execute') {
        handlers.onExecute?.(String(params?.command ?? ''));
        for (const cb of [...saveCallbacks]) {
          cb({ app: 'docs', name: 'notes/plan.docx', bytes: new Uint8Array([9, 9]) });
        }
      }
      return { ok: true };
    }),
  };
  return { bridge, opened, saveCallbacks };
}

describe('CraftRelayClient', () => {
  it('executes a craft command on the mounted bridge and posts the result to the workspace route', async () => {
    const { bridge } = fakeBridge();
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/stream')) {
        return sseResponse([craftFrame('ws_1', 'engine.execute', { command: 'text.insert', params: { text: 'hi' } })]);
      }
      posted.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const live = new CraftRelayClient({
      taskId: 'task-1',
      getBridge: () => bridge,
      fetchFn: fetchFn as unknown as typeof fetch,
      headers: () => ({}),
      autoReconnect: false,
    });

    await live.start();
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(bridge.call).toHaveBeenCalledWith('engine.execute', { command: 'text.insert', params: { text: 'hi' } });
    expect(posted[0]?.url).toContain('/api/tasks/task-1/workspace/result');
    expect(posted[0]?.body).toMatchObject({ id: 'ws_1', taskId: 'task-1', ok: true, result: { ok: true } });
    live.stop();
  });

  it('craft.waitSave runs file.save and resolves with the stored task-file path', async () => {
    const { bridge } = fakeBridge();
    const uploadBytes = vi.fn(async () => undefined);
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/stream')) {
        return sseResponse([craftFrame('ws_2', 'craft.waitSave', {})]);
      }
      posted.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new CraftRelayClient({
      taskId: 'task-1',
      getBridge: () => bridge,
      uploadBytes,
      fetchFn: fetchFn as unknown as typeof fetch,
      headers: () => ({}),
      autoReconnect: false,
    });

    await client.start();
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(bridge.call).toHaveBeenCalledWith('engine.execute', { command: 'file.save', params: {} });
    expect(uploadBytes).toHaveBeenCalledWith('task-1', 'notes/plan.docx', expect.any(Uint8Array));
    expect(posted[0]?.body).toMatchObject({ id: 'ws_2', ok: true, result: { path: 'notes/plan.docx' } });
    client.stop();
  });

  it('craft.open fetches the task file and drops it into the editor', async () => {
    const { bridge, opened } = fakeBridge();
    const fetchBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/stream')) {
        return sseResponse([craftFrame('ws_3', 'craft.open', { path: 'notes/plan.docx' })]);
      }
      posted.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new CraftRelayClient({
      taskId: 'task-1',
      getBridge: () => bridge,
      fetchBytes,
      fetchFn: fetchFn as unknown as typeof fetch,
      headers: () => ({}),
      autoReconnect: false,
    });

    await client.start();
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(fetchBytes).toHaveBeenCalledWith('task-1', 'notes/plan.docx');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.name).toBe('plan.docx');
    expect(Array.from(opened[0]?.bytes ?? [])).toEqual([1, 2, 3]);
    expect(posted[0]?.body).toMatchObject({ id: 'ws_3', ok: true, result: { opened: 'notes/plan.docx' } });
    client.stop();
  });

  it('posts a failed result when no panel is mounted for the target', async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/stream')) return sseResponse([craftFrame('ws_4')]);
      posted.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new CraftRelayClient({
      taskId: 'task-1',
      getBridge: () => null,
      fetchFn: fetchFn as unknown as typeof fetch,
      headers: () => ({}),
      autoReconnect: false,
    });

    await client.start();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toMatchObject({ id: 'ws_4', ok: false });
    expect(String(posted[0]?.body.error)).toMatch(/no Loam docs panel/);
    client.stop();
  });

  it('ignores legacy video studio frames', async () => {
    const { bridge } = fakeBridge();
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/stream')) return sseResponse([videoFrame('vs_1')]);
      posted.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const live = new CraftRelayClient({
      taskId: 'task-1',
      getBridge: () => bridge,
      fetchFn: fetchFn as unknown as typeof fetch,
      headers: () => ({}),
      autoReconnect: false,
    });

    await live.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.call).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
    live.stop();
  });

  it('reports a workspace open request so the shell can open the panel', async () => {
    const { bridge } = fakeBridge();
    const openRequests: Array<{ target: string; path: string | null }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/stream')) {
        return sseResponse([`data: ${JSON.stringify({ type: 'workspace_open_request', target: 'sheets', path: 'book.xlsx' })}\n\n`]);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new CraftRelayClient({
      taskId: 'task-1',
      getBridge: () => bridge,
      fetchFn: fetchFn as unknown as typeof fetch,
      headers: () => ({}),
      autoReconnect: false,
      onOpenRequest: (request) => openRequests.push({ target: request.target, path: request.path ?? null }),
    });

    await client.start();
    await vi.waitFor(() => expect(openRequests).toHaveLength(1));
    expect(openRequests[0]).toEqual({ target: 'sheets', path: 'book.xlsx' });
    client.stop();
  });

  it('resolves a real CraftBridge target through the executor', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const bridge = { call } as unknown as CraftBridge;
    const executor = craftRelayExecutor({ taskId: 't', getBridge: () => bridge as unknown as CraftBridgeLike });
    const command: CraftRelayCommand = { id: 'x', taskId: 't', target: 'sheets', method: 'sheet.read', params: { range: 'A1:B2' } };
    await expect(executor(command)).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('sheet.read', { range: 'A1:B2' });
  });
});
