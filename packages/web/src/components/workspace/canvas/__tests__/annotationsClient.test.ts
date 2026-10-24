/**
 * Neo N18: the canvas annotation HTTP client.
 *
 * Annotations are the user's layer, so these tests pin the URL shape of every
 * route the panel uses, the bodies it sends, and the two failure modes the panel
 * turns into a notice: a malformed payload and a non-2xx reply.
 */
import { describe, expect, it, vi } from 'vitest';

import { CanvasAnnotationsClient } from '../annotationsClient';

const RUN = 'task canvas/1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  method?: string;
  /** The parsed request body, already JSON-decoded. */
  body?: Record<string, unknown>;
}

function recordingClient(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  const client = new CanvasAnnotationsClient({
    apiBase: 'http://127.0.0.1:3939',
    headers: () => ({ 'x-loam-install-token': 'tok' }),
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, calls, fetchFn };
}

const ANNOTATIONS = {
  runId: RUN,
  tags: { n1: 'blue' },
  comments: { n1: [{ id: 'c1', author: 'user', text: 'hello', created: 1 }] },
  notes: [],
};

describe('canvas annotations client', () => {
  it('reads the whole annotation layer for a run, encoding the id', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(ANNOTATIONS));
    const loaded = await client.getAnnotations(RUN);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}/annotations`);
    expect(calls[0]!.method).toBeUndefined();
    expect(loaded.tags.n1).toBe('blue');
  });

  it('sends a colour patch and clears a tag with "none"', async () => {
    const { client, calls } = recordingClient(() => jsonResponse({}));
    await client.setColour(RUN, 'n1', { colour: 'green' });
    await client.setColour(RUN, 'n1', { colour: 'none' });
    expect(calls.map((call) => call.method)).toEqual(['PATCH', 'PATCH']);
    expect(calls[0]!.url).toBe(
      `http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}/nodes/n1/colour`,
    );
    expect(calls.map((call) => call.body)).toEqual([{ colour: 'green' }, { colour: 'none' }]);
  });

  it('appends a comment and reads the server-assigned id', async () => {
    const { client, calls } = recordingClient(() => jsonResponse({ comment: ANNOTATIONS.comments.n1![0] }));
    const comment = await client.addComment(RUN, 'n1', { text: 'hello' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(
      `http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}/nodes/n1/comments`,
    );
    expect(calls[0]!.body).toEqual({ text: 'hello' });
    expect(comment.id).toBe('c1');
  });

  it('deletes a comment and a note without a body', async () => {
    const { client, calls } = recordingClient(() => jsonResponse({}));
    await client.removeComment(RUN, 'n1', 'c1');
    await client.removeNote(RUN, 'note1');
    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'DELETE']);
    expect(calls[0]!.url).toBe(
      `http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}/nodes/n1/comments/c1`,
    );
    expect(calls[1]!.url).toBe(`http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}/notes/note1`);
    // A DELETE carries no body; some servers reject an empty one.
    expect(calls.every((call) => call.body === undefined)).toBe(true);
  });

  it('creates a note with its position and moves it with a patch', async () => {
    const note = { id: 'note1', text: 'remember', x: 120, y: 240, colour: 'none', created: 1, updated: 1 };
    const { client, calls } = recordingClient((call) => jsonResponse({ note: { ...note, ...(call.body ?? {}) } }));
    await client.addNote(RUN, { text: 'remember', x: 120, y: 240 });
    await client.updateNote(RUN, 'note1', { x: 400, y: 80 });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.body).toEqual({ x: 400, y: 80 });
  });

  it('turns a non-2xx reply into the error the panel shows', async () => {
    const { client } = recordingClient(() => jsonResponse({ error: 'limit reached' }, 413));
    await expect(client.addNote(RUN, { text: 'x', x: 0, y: 0 })).rejects.toThrow('limit reached');
  });

  it('reports a malformed annotation payload instead of returning junk', async () => {
    const { client } = recordingClient(() => jsonResponse({ tags: {} }));
    await expect(client.getAnnotations(RUN)).rejects.toThrow(/malformed/i);
  });

  it('reports a reply that carries no comment rather than a half-built one', async () => {
    const { client } = recordingClient(() => jsonResponse({}));
    await expect(client.addComment(RUN, 'n1', { text: 'x' })).rejects.toThrow(/no comment/i);
  });
});
