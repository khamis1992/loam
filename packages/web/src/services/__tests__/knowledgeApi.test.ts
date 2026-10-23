import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listKnowledgeBases,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  ingestKnowledge,
  addKnowledgeSeed,
  retagKnowledgeSeed,
  deleteKnowledgeSeed,
  searchKnowledge,
} from '../knowledgeApi.js';

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

describe('knowledgeApi (Knowledge Garden client)', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists bases and reports whether the vector channel is enabled', async () => {
    stubFetch(() => jsonResponse({ bases: [{ id: 'kb-1', name: 'Docs', seeds: 3 }], enabled: true }));
    const data = await listKnowledgeBases();
    expect(data.enabled).toBe(true);
    expect(data.bases).toHaveLength(1);
    expect(data.bases[0]).toMatchObject({ id: 'kb-1', name: 'Docs', seeds: 3 });
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/api/knowledge'))).toBe(true);
  });

  it('creates a base with a JSON body', async () => {
    stubFetch(() => jsonResponse({ base: { id: 'kb-2', name: 'Product docs' } }, 201));
    await createKnowledgeBase('Product docs', 'specs');
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/knowledge'));
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ name: 'Product docs', description: 'specs' });
  });

  it('renames a base via PUT and deletes it via DELETE', async () => {
    stubFetch(() => jsonResponse({ base: { id: 'kb-2', name: 'Renamed' } }));
    await updateKnowledgeBase('kb-2', { name: 'Renamed' });
    expect(calls[0]).toMatchObject({ method: 'PUT', url: expect.stringContaining('/api/knowledge/kb-2') });

    calls = [];
    stubFetch(() => jsonResponse({ ok: true, baseId: 'kb-2' }));
    await deleteKnowledgeBase('kb-2');
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/api/knowledge/kb-2') });
  });

  it('fetches one base with its seeds', async () => {
    stubFetch(() => jsonResponse({ base: { id: 'kb-3', name: 'A' }, seeds: [{ id: 'seed-1', title: 'T', tags: ['x'] }] }));
    const data = await getKnowledgeBase('kb-3');
    expect(data.seeds).toHaveLength(1);
    expect(data.seeds[0]!.title).toBe('T');
  });

  it('imports text into a base via POST .../ingest', async () => {
    stubFetch(() => jsonResponse({ ok: true, seeds: [{ id: 'seed-1' }], warnings: [] }, 201));
    await ingestKnowledge('kb-3', { text: 'hello world', tags: ['misc'] });
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/knowledge/kb-3/ingest'));
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ text: 'hello world', tags: ['misc'] });
  });

  it('adds, retags and deletes a seed', async () => {
    stubFetch(() => jsonResponse({ seed: { id: 'seed-9', title: 'Manual' } }, 201));
    await addKnowledgeSeed('kb-3', { title: 'Manual', body: 'note', tags: ['a'] });
    expect(calls[0]).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/knowledge/kb-3/seeds') });

    calls = [];
    stubFetch(() => jsonResponse({ seed: { id: 'seed-9', tags: ['b'] } }));
    await retagKnowledgeSeed('kb-3', 'seed-9', ['b']);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: expect.stringContaining('/api/knowledge/kb-3/seeds/seed-9') });
    expect(calls[0]!.body).toEqual({ tags: ['b'] });

    calls = [];
    stubFetch(() => jsonResponse({ ok: true, seedId: 'seed-9' }));
    await deleteKnowledgeSeed('kb-3', 'seed-9');
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/api/knowledge/kb-3/seeds/seed-9') });
  });

  it('searches with query, base filter and k as query params', async () => {
    stubFetch(() => jsonResponse({ query: 'billing', mode: 'hybrid', empty: false, hits: [{ seedId: 'seed-1' }] }));
    const data = await searchKnowledge('billing', 'kb-3', 5);
    expect(data.mode).toBe('hybrid');
    expect(data.hits).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url).toContain('/api/knowledge/search?');
    expect(url).toContain('query=billing');
    expect(url).toContain('baseId=kb-3');
    expect(url).toContain('k=5');
  });

  it('omits baseId when no base is selected', async () => {
    stubFetch(() => jsonResponse({ query: 'x', mode: 'lexical', empty: true, hits: [] }));
    await searchKnowledge('x');
    expect(calls[0]!.url).not.toContain('baseId=');
  });

  it('percent-encodes ids and query text', async () => {
    stubFetch(() => jsonResponse({ ok: true, seedId: 'a/b' }));
    await deleteKnowledgeSeed('kb-3', 'a/b');
    expect(calls[0]!.url).toContain(encodeURIComponent('a/b'));

    calls = [];
    stubFetch(() => jsonResponse({ query: 'x y', mode: 'lexical', empty: true, hits: [] }));
    await searchKnowledge('x y');
    // URLSearchParams form-encodes spaces as '+', which the server decodes back.
    expect(calls[0]!.url).toContain('query=x+y');
  });

  it('throws the server error message on failure', async () => {
    stubFetch(() => jsonResponse({ error: 'knowledge base kb-nope not found' }, 404));
    await expect(getKnowledgeBase('kb-nope')).rejects.toThrow('knowledge base kb-nope not found');
  });
});
