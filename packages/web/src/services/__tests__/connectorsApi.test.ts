import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listConnectors, connectConnector, disconnectConnector } from '../connectorsApi.js';

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
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const call: Call = { url, method, body, headers };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch,
  );
}

const github = { id: 'github', name: 'GitHub', configured: true, connected: true, account: 'octocat', envVars: [] };
const gmail = {
  id: 'gmail',
  name: 'Gmail',
  configured: false,
  connected: false,
  account: null,
  envVars: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'],
};

describe('connectorsApi', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists connectors and their connected/configured state via GET /api/connectors', async () => {
    stubFetch(() => jsonResponse({ connectors: [github, gmail] }));
    const data = await listConnectors();
    expect(data.connectors).toHaveLength(2);
    expect(data.connectors[0]).toMatchObject({ id: 'github', connected: true, account: 'octocat' });
    expect(data.connectors[1]).toMatchObject({ id: 'gmail', configured: false, envVars: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'] });
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/api/connectors'))).toBe(true);
  });

  it('starts the OAuth handshake via POST /api/connectors/:id/connect', async () => {
    stubFetch(() => jsonResponse({ authUrl: 'https://github.com/login/oauth/authorize?challenge=abc' }));
    const data = await connectConnector('github');
    expect(data.authUrl).toContain('github.com');
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/connectors/github/connect'));
    expect(post).toBeTruthy();
    expect(post!.headers?.['content-type']).toBe('application/json');
  });

  it('revokes a connector via POST /api/connectors/:id/disconnect', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    await disconnectConnector('gmail');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/connectors/gmail/disconnect'))).toBe(true);
  });

  it('percent-encodes the connector id in the path', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    await disconnectConnector('a/b c');
    expect(calls[0]!.url).toContain(encodeURIComponent('a/b c'));
  });

  it('throws the server error message when the request fails', async () => {
    stubFetch(() => jsonResponse({ error: 'connector not configured' }, 400));
    await expect(connectConnector('gmail')).rejects.toThrow('connector not configured');
  });

  it('falls back to the status code when the error body has no message', async () => {
    stubFetch(() => jsonResponse({}, 503));
    await expect(listConnectors()).rejects.toThrow('503');
  });
});
