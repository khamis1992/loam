/**
 * Neo N2: the canvas live stream client.
 *
 * The stream is the only way a running run updates the canvas without a poll, so
 * these tests pin the protocol: the right URL and auth header, snapshot then
 * change dispatch, keep-alive comments ignored, and reconnect when the stream
 * closes. Everything is driven through an injected fetch, so no network.
 */
import { describe, expect, it, vi } from 'vitest';

import { CanvasStream, type CanvasStreamChange, type CanvasStreamSnapshot } from '../stream';

/** A fetch stub returning a stream that emits the given SSE frames and ends. */
function streamingFetch(frames: string[], onRequest?: (url: string, init?: RequestInit) => void) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    onRequest?.(String(url), init);
    const body = closingBody(frames);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/**
 * A stream that emits `frames` and then ends, which is what a real server does
 * when it closes. The pump resolves on `done`, so `start()` can be awaited.
 */
function closingBody(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join('')));
      controller.close();
    },
  });
}

/** A stream that emits `frames` and stays open until `close()` is called. */
function openBody(frames: string[]): { body: ReadableStream<Uint8Array>; close: () => void } {
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join('')));
      close = () => controller.close();
    },
  });
  return { body, close };
}

describe('canvas stream', () => {
  it('opens the stream URL with the auth header', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchFn = streamingFetch([], (url, init) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
    }) as unknown as typeof fetch;
    const stream = new CanvasStream({
      runId: 'task_1',
      apiBase: 'http://127.0.0.1:3939',
      headers: () => ({ 'x-loam-install-token': 'tok' }),
      fetchFn,
    });
    await stream.start();
    expect(seen[0]!.url).toBe('http://127.0.0.1:3939/api/graph/task_1/stream');
    expect(seen[0]!.headers!['x-loam-install-token']).toBe('tok');
    stream.stop();
  });

  it('dispatches the snapshot first, then one change per graph update', async () => {
    const snapshots: CanvasStreamSnapshot[] = [];
    const changes: CanvasStreamChange[] = [];
    const fetchFn = streamingFetch([
      'data: {"type":"snapshot","runId":"task_1","nodes":[{"id":"n1"}],"edges":[],"stats":{"totalNodes":1}}\n\n',
      'data: {"type":"change","runId":"task_1","nodeIds":["n2"],"seq":4}\n\n',
      'data: {"type":"change","runId":"task_1","nodeIds":["n3"],"seq":5}\n\n',
    ]) as unknown as typeof fetch;
    const stream = new CanvasStream({
      runId: 'task_1',
      apiBase: 'http://127.0.0.1:3939',
      fetchFn,
      handlers: {
        onSnapshot: (frame) => snapshots.push(frame),
        onChange: (frame) => changes.push(frame),
      },
    });
    await stream.start();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.runId).toBe('task_1');
    expect(snapshots[0]!.nodes).toEqual([{ id: 'n1' }]);
    expect(changes.map((frame) => frame.nodeIds)).toEqual([['n2'], ['n3']]);
    expect(changes[0]!.seq).toBe(4);
    stream.stop();
  });

  it('ignores keep-alive comments and frames split across chunks', async () => {
    const changes: CanvasStreamChange[] = [];
    const fetchFn = vi.fn(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': keep-alive 1\n\n'));
          // The change frame arrives in two chunks, as a real proxy would send it.
          controller.enqueue(encoder.encode('data: {"type":"change","runId":"r","nodeIds":["a"],"'));
          controller.enqueue(encoder.encode('seq":7}\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const stream = new CanvasStream({
      runId: 'r',
      apiBase: 'http://127.0.0.1:3939',
      fetchFn,
      handlers: { onChange: (frame) => changes.push(frame) },
    });
    await stream.start();
    // The keep-alive comment produced no frame.
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe('change');
    expect(changes[0]!.nodeIds).toEqual(['a']);
    expect(changes[0]!.seq).toBe(7);
    stream.stop();
  });

  it('reconnects when the stream closes, and stops reconnecting on stop()', async () => {
    const attempts: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      attempts.push(String(url));
      return new Response(closingBody([
        'data: {"type":"snapshot","runId":"r","nodes":[],"edges":[],"stats":{}}\n\n',
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const scheduled: Array<() => void> = [];
    const stream = new CanvasStream({
      runId: 'r',
      apiBase: 'http://127.0.0.1:3939',
      fetchFn,
      reconnectDelayMs: 5,
      scheduler: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });
    await stream.start();
    // The first connection closed, so exactly one reconnect is scheduled.
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    // Reconnecting re-enters `start()`, which resolves asynchronously.
    await Promise.resolve();
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    // The stream reconnected once.
    expect(attempts).toHaveLength(2);
    stream.stop();
    expect(stream.isRunning()).toBe(false);
  });

  it('reports an error and does not reconnect once stopped', async () => {
    const onError = vi.fn();
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const scheduled: Array<() => void> = [];
    const stream = new CanvasStream({
      runId: 'r',
      apiBase: 'http://127.0.0.1:3939',
      fetchFn,
      handlers: { onError },
      scheduler: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
    });
    await stream.start();
    expect(onError).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    stream.stop();
    // The reconnect is scheduled but must not fire once the stream is stopped.
    scheduled[0]!();
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-2xx stream as an error', async () => {
    const onError = vi.fn();
    const fetchFn = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const stream = new CanvasStream({
      runId: 'r',
      apiBase: 'http://127.0.0.1:3939',
      fetchFn,
      handlers: { onError },
      scheduler: () => undefined,
    });
    await stream.start();
    expect(onError).toHaveBeenCalledOnce();
    expect(stream.isRunning()).toBe(false);
    stream.stop();
  });

  it('stays connected while the stream is open, so no reconnect is scheduled', async () => {
    const snapshots: CanvasStreamSnapshot[] = [];
    const { body, close } = openBody([
      'data: {"type":"snapshot","runId":"r","nodes":[],"edges":[],"stats":{}}\n\n',
    ]);
    const fetchFn = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const scheduled: Array<() => void> = [];
    const stream = new CanvasStream({
      runId: 'r',
      apiBase: 'http://127.0.0.1:3939',
      fetchFn,
      handlers: { onSnapshot: (frame) => snapshots.push(frame) },
      scheduler: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
    });
    const connecting = stream.start();
    // Give the reader a turn to consume the snapshot.
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    // An open stream must not reconnect.
    expect(scheduled).toHaveLength(0);
    close();
    await connecting;
    stream.stop();
  });
});
