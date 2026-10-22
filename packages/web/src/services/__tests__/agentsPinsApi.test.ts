import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('../rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({ 'x-test': '1' }),
}));

import { reorderPinnedAgents, setAgentPinned } from '../agentsPinsApi.js';

interface Call {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
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
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = { url, method, body, headers };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch,
  );
}

const pinUrl = (id: string) => `${API}/api/agents/${encodeURIComponent(id)}/pin`;

describe('agentsPinsApi', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pins an agent with POST and the pinned flag in the body', async () => {
    stubFetch(() => jsonResponse({ agent: { id: 'a1', name: 'Ada', pinnedAt: 1 } }));
    const result = await setAgentPinned('a1', true);

    expect(result.agent).toMatchObject({ id: 'a1', name: 'Ada' });
    const post = calls.find((c) => c.url === pinUrl('a1'));
    expect(post).toBeTruthy();
    expect(post!.method).toBe('POST');
    expect(post!.body).toEqual({ pinned: true });
  });

  it('unpins by sending pinned: false', async () => {
    stubFetch(() => jsonResponse({ agent: { id: 'a1', name: 'Ada' } }));
    await setAgentPinned('a1', false);
    expect(calls.find((c) => c.url === pinUrl('a1'))!.body).toEqual({ pinned: false });
  });

  it('URL-encodes agent ids that need it', async () => {
    stubFetch(() => jsonResponse({ agent: { id: 'a/1', name: 'Slash' } }));
    await setAgentPinned('a/1', true);
    expect(calls.some((c) => c.url === pinUrl('a/1'))).toBe(true);
    expect(calls[0]!.url).toContain(encodeURIComponent('a/1'));
  });

  it('reorders pinned agents via POST /api/agents/reorder', async () => {
    stubFetch(() =>
      jsonResponse({
        pinned: [{ id: 'b' }],
        agents: [{ id: 'a' }, { id: 'b' }],
      }),
    );
    const result = await reorderPinnedAgents(['b', 'a']);

    expect(result.pinned.map((a) => a.id)).toEqual(['b']);
    expect(result.agents.map((a) => a.id)).toEqual(['a', 'b']);
    const post = calls.find((c) => c.url === `${API}/api/agents/reorder`);
    expect(post).toBeTruthy();
    expect(post!.method).toBe('POST');
    expect(post!.body).toEqual({ ids: ['b', 'a'] });
  });

  it('throws the server error message on failure', async () => {
    stubFetch(() => jsonResponse({ error: 'not allowed' }, 403));
    await expect(setAgentPinned('a1', true)).rejects.toThrow('not allowed');
  });

  it('falls back to the status code when the body has no message', async () => {
    stubFetch(() => jsonResponse({}, 500));
    await expect(reorderPinnedAgents(['a'])).rejects.toThrow('500');
  });
});
