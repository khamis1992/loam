import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  DEFAULT_RAISE_STEPS,
  DEFAULT_RAISE_TOKENS,
  fetchSessionRuntime,
  raiseSessionBudget,
  raiseSessionBudgetDefault,
  sleepSession,
  wakeSession,
} from '../sessionRuntimeApi.js';

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

const snapshot = {
  sessionId: 's1',
  state: 'idle',
  sleeping: false,
  budget: { steps: 8, stepLimit: 10, tokens: 0, tokenLimit: 100, percent: 80, stopped: false },
  raised: false,
};

describe('sessionRuntimeApi', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the runtime snapshot for the badge', async () => {
    stubFetch(() => jsonResponse({ session: snapshot, defaults: { idleMinutes: 30, stepLimit: 40, tokenLimit: 500000 } }));
    const res = await fetchSessionRuntime('s1', { Authorization: 'Bearer t' });
    expect(res.session.budget.percent).toBe(80);
    const call = calls.find((c) => c.url.includes('/api/sessions/s1/runtime'))!;
    expect(call.method).toBe('GET');
  });

  it('url-encodes the session id', async () => {
    stubFetch(() => jsonResponse({ session: snapshot, defaults: {} }));
    await fetchSessionRuntime('a/b');
    expect(calls[0]!.url).toContain('/api/sessions/a%2Fb/runtime');
  });

  it('sleeps and wakes over HTTP', async () => {
    stubFetch(() => jsonResponse({ session: { ...snapshot, state: 'sleeping', sleeping: true }, defaults: {} }));
    await sleepSession('s1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/api/sessions/s1/sleep');
    await wakeSession('s1');
    expect(calls[1]!.url).toContain('/api/sessions/s1/wake');
  });

  it('raises the budget with the default amounts', async () => {
    stubFetch(() => jsonResponse({ session: { ...snapshot, budget: { ...snapshot.budget, stepLimit: 50, percent: 16, stopped: false } }, defaults: {}, raised: true }));
    const res = await raiseSessionBudgetDefault('s1');
    expect(res.raised).toBe(true);
    const call = calls[0]!;
    expect(call.url).toContain('/api/sessions/s1/budget');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ steps: DEFAULT_RAISE_STEPS, tokens: DEFAULT_RAISE_TOKENS });
  });

  it('sends a custom raise delta', async () => {
    stubFetch(() => jsonResponse({ session: snapshot, defaults: {}, raised: true }));
    await raiseSessionBudget('s1', { steps: 5 });
    expect(calls[0]!.body).toEqual({ steps: 5 });
  });

  it('throws the server error message on failure', async () => {
    stubFetch(() => jsonResponse({ error: 'budget increase must be a positive number' }, 400));
    await expect(raiseSessionBudget('s1', { steps: 0 })).rejects.toThrow('budget increase must be a positive number');
  });

  it('falls back to the status code when the body has no message', async () => {
    stubFetch(() => jsonResponse({}, 500));
    await expect(fetchSessionRuntime('s1')).rejects.toThrow('500');
  });
});
