import { describe, expect, it, vi } from 'vitest';
import {
  VideoStudioClient,
  createEffectcraftExecutor,
  createFilmcraftExecutor,
  createRoundTripExecutor,
  type VideoStudioCommand,
} from './videoStudioClient';

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

function commandFrame(id: string, method = 'inspect'): string {
  return `data: ${JSON.stringify({ type: 'video_studio_command', id, taskId: 'task-1', target: 'film', method, params: {} })}\n\n`;
}

describe('VideoStudioClient', () => {
  it('executes a stream command with the bridge and posts the result', async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const executor = vi.fn(async (_command: VideoStudioCommand) => ({ clips: 3 }));
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/stream')) {
        return sseResponse([commandFrame('vs_1')]);
      }
      posted.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new VideoStudioClient({
      taskId: 'task-1',
      executor,
      apiBase: 'http://127.0.0.1:3939',
      headers: () => ({ 'x-loam-local-token': 'tok' }),
      fetchFn: fetchFn as unknown as typeof fetch,
      autoReconnect: false,
    });

    await client.start();
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(executor.mock.calls[0]?.[0]).toMatchObject({ id: 'vs_1', target: 'film', method: 'inspect' });
    expect(posted[0]?.url).toContain('/api/tasks/task-1/video-studio/result');
    expect(posted[0]?.body).toMatchObject({ id: 'vs_1', taskId: 'task-1', ok: true, result: { clips: 3 } });
    client.stop();
  });

  it('posts an error result when the executor throws', async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const executor = vi.fn(async () => {
      throw new Error('bridge is down');
    });
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/stream')) return sseResponse([commandFrame('vs_2', 'execute')]);
      posted.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new VideoStudioClient({
      taskId: 'task-1',
      executor,
      apiBase: 'http://127.0.0.1:3939',
      headers: () => ({}),
      fetchFn: fetchFn as unknown as typeof fetch,
      autoReconnect: false,
    });

    await client.start();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toMatchObject({ id: 'vs_2', ok: false, error: 'bridge is down' });
    client.stop();
  });

  it('ignores unrelated stream events', async () => {
    const executor = vi.fn(async () => ({}));
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/stream')) {
        return sseResponse([
          `data: ${JSON.stringify({ type: 'task-status', status: 'running' })}\n\n`,
          ': keepalive\n\n',
        ]);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new VideoStudioClient({
      taskId: 'task-1',
      executor,
      apiBase: 'http://127.0.0.1:3939',
      headers: () => ({}),
      fetchFn: fetchFn as unknown as typeof fetch,
      autoReconnect: false,
    });

    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executor).not.toHaveBeenCalled();
    client.stop();
  });

  it('routes film commands through the Loam Video bridge executor', async () => {
    const call = vi.fn(async (_method: string, ..._args: unknown[]) => ({ ok: true }));
    const bridge = { call } as unknown as Parameters<typeof createFilmcraftExecutor>[0];
    const executor = createFilmcraftExecutor(bridge);
    await expect(executor({ id: 'x', taskId: 't', target: 'film', method: 'inspect', params: {} })).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('inspect', {});

    await expect(
      executor({ id: 'x', taskId: 't', target: 'effects', method: 'inspect', params: {} }),
    ).rejects.toThrow(/Loam Effects/);
  });

  it('routes effects commands through the Loam Effects bridge executor', async () => {
    const call = vi.fn(async (_method: string, ..._args: unknown[]) => ({ projectPath: 'effects/clip.ecproj' }));
    const bridge = { call } as unknown as Parameters<typeof createEffectcraftExecutor>[0];
    const executor = createEffectcraftExecutor(bridge);
    await expect(executor({ id: 'x', taskId: 't', target: 'effects', method: 'inspect', params: {} })).resolves.toEqual({
      projectPath: 'effects/clip.ecproj',
    });
    expect(call).toHaveBeenCalledWith('inspect', {});

    // The two engines are separate iframes; a film command must never be answered
    // by the effects bridge.
    await expect(
      executor({ id: 'x', taskId: 't', target: 'film', method: 'inspect', params: {} }),
    ).rejects.toThrow(/Loam Video/);
  });

  it('fans a round trip out to the engine that owns each step', async () => {
    const filmCall = vi.fn(async (_method: string, ..._args: unknown[]) => 'film-ok');
    const effectsCall = vi.fn(async (_method: string, ..._args: unknown[]) => 'effects-ok');
    const film = { call: filmCall } as unknown as Parameters<typeof createRoundTripExecutor>[0];
    const effects = { call: effectsCall } as unknown as Parameters<typeof createRoundTripExecutor>[1];
    const executor = createRoundTripExecutor(film, effects);

    await expect(executor({ id: 'a', taskId: 't', target: 'effects', method: 'addFile', params: {} })).resolves.toEqual('effects-ok');
    await expect(executor({ id: 'b', taskId: 't', target: 'film', method: 'importFiles', params: {} })).resolves.toEqual('film-ok');

    expect(effectsCall).toHaveBeenCalledTimes(1);
    expect(filmCall).toHaveBeenCalledTimes(1);
    expect(filmCall).toHaveBeenCalledWith('importFiles', {});
    // An unknown target is refused rather than silently dropped on the floor.
    await expect(
      executor({ id: 'c', taskId: 't', target: 'audio', method: 'inspect', params: {} } as unknown as VideoStudioCommand),
    ).rejects.toThrow(/unknown video studio target/);
  });
});
