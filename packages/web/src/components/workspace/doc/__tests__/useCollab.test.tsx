// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://127.0.0.1:3939',
  getApiHeaders: async () => ({ 'x-test': '1' }),
}));

import { useCollab } from '../useCollab';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      // Keep the stream open (like a real SSE connection) until cancelled.
    },
    cancel() { /* client hung up */ },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const FILE = { taskId: 'task_t1', path: 'docs/a.docx', name: 'a.docx', kind: 'doc' } as never;

describe('useCollab (د3 client)', () => {
  afterEach(cleanup);

  it('joins, receives a remote patch, and filters its own echo', async () => {
    const patches: Array<{ clientId: string; authorName: string; op: unknown }> = [];
    let selfId = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/collab/join')) {
        // The client self-identifies with a random UUID in the join body.
        const sent = JSON.parse(String(init?.body ?? '{}')) as { clientId: string };
        selfId = sent.clientId;
        return new Response(JSON.stringify({ seq: 3, members: [{ clientId: selfId, name: 'أنا', color: '#0081f2' }, { clientId: 'peer-9', name: 'سارة', color: '#5eb92d' }], color: '#0081f2' }), { status: 200 });
      }
      if (url.includes('/api/collab/stream')) {
        return sseResponse([
          `event: presence\ndata: ${JSON.stringify({ members: [{ clientId: selfId, name: 'أنا', color: '#0081f2' }, { clientId: 'peer-9', name: 'سارة', color: '#5eb92d' }] })}\n\n`,
          // A remote patch from peer-9…
          'event: patch\ndata: {"seq":4,"clientId":"peer-9","op":{"kind":"insert","paragraphId":"p1","offset":0,"text":"سارة: "}}\n\n',
          // …and our own echo (must be filtered) — echoes carry OUR client id.
          `event: patch\ndata: ${JSON.stringify({ seq: 5, clientId: selfId, op: { kind: 'insert', paragraphId: 'p1', offset: 9, text: 'أنا' } })}\n\n`,
        ]);
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    function Host() {
      useCollab({
        file: FILE, enabled: true, displayName: 'أنا',
        onPatch: (patch) => patches.push(patch),
        onConflict: () => undefined,
      });
      return null;
    }
    render(<Host />);

    await waitFor(() => expect(patches.length).toBe(1), { timeout: 2000 });
    expect(patches[0]!.clientId).toBe('peer-9');
    expect(patches[0]!.authorName).toBe('سارة');
    expect(patches[0]!.op).toEqual({ kind: 'insert', paragraphId: 'p1', offset: 0, text: 'سارة: ' });
    vi.unstubAllGlobals();
  });

  it('surfaces a conflict when the server rejects a stale op (409)', async () => {
    let conflicts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/collab/join')) {
        return new Response(JSON.stringify({ seq: 2, members: [], color: '#0081f2' }), { status: 200 });
      }
      if (url.includes('/api/collab/stream')) return sseResponse([]);
      if (url.includes('/api/collab/op')) {
        return new Response(JSON.stringify({ error: 'stale', seq: 7 }), { status: 409 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    let send: ((op: never) => void) | null = null;
    function Host() {
      const collab = useCollab({
        file: FILE, enabled: true, displayName: 'أنا',
        onPatch: () => undefined,
        onConflict: () => { conflicts += 1; },
      });
      send = collab.sendOp as unknown as (op: never) => void;
      return null;
    }
    render(<Host />);
    await waitFor(() => expect(send).toBeTruthy(), { timeout: 2000 });
    send!({ kind: 'insert', paragraphId: 'p1', offset: 0, text: 'x' } as never);
    await waitFor(() => expect(conflicts).toBe(1), { timeout: 2000 });
    vi.unstubAllGlobals();
  });
});
