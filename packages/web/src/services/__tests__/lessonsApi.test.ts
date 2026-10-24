import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listLessons,
  setLessonDisabled,
  deleteLesson,
} from '../lessonsApi.js';

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const call: Call = { url, method, body };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch,
  );
}

describe('lessonsApi (learned-lessons client)', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists lessons and unwraps the data envelope', async () => {
    stubFetch(() => jsonResponse({ data: [{ id: 'les_1', lesson: 'Write نتريو in Arabic' }] }));
    const data = await listLessons();
    expect(data.data).toHaveLength(1);
    expect(data.data[0]!.id).toBe('les_1');
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/api/learning/lessons'))).toBe(true);
  });

  it('passes agentId and domain as query params and percent-encodes them', async () => {
    stubFetch(() => jsonResponse({ data: [] }));
    await listLessons({ agentId: 'a/b', domain: 'nutrio content' });
    const url = calls[0]!.url;
    expect(url).toContain('/api/learning/lessons?');
    expect(url).toContain('agentId=a%2Fb');
    // URLSearchParams form-encodes spaces as '+', which the server decodes back.
    expect(url).toContain('domain=nutrio+content');
  });

  it('omits the query string entirely when no filter is given', async () => {
    stubFetch(() => jsonResponse({ data: [] }));
    await listLessons();
    expect(calls[0]!.url).not.toContain('?');
  });

  it('patches a lesson disabled flag via PATCH with a JSON body', async () => {
    stubFetch(() => jsonResponse({ data: { id: 'les_2', disabled: true } }));
    const data = await setLessonDisabled('les_2', true);
    expect(data.data.disabled).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: expect.stringContaining('/api/learning/lessons/les_2') });
    expect(calls[0]!.body).toEqual({ disabled: true });
  });

  it('deletes a lesson via DELETE and percent-encodes the id', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await deleteLesson('a/b');
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/api/learning/lessons/a%2Fb') });
  });

  it('throws the server error message on failure', async () => {
    stubFetch(() => jsonResponse({ error: 'no lesson les_nope' }, 404));
    await expect(setLessonDisabled('les_nope', true)).rejects.toThrow('no lesson les_nope');
  });

  it('surfaces a delete failure instead of silently dropping the row', async () => {
    stubFetch(() => jsonResponse({ error: 'no lesson les_nope' }, 404));
    await expect(deleteLesson('les_nope')).rejects.toThrow('no lesson les_nope');
  });
});
