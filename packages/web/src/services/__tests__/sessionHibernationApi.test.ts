import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchSessionHibernation,
  requestHibernation,
  wakeHibernatedSession,
  wakeHibernatedSessionWithAuth,
} from '../sessionHibernationApi.js';

/** Module-namespace stub: the api imports these bindings directly, so the mock
 *  must be hoisted above the import for ESM to honour it. */
const rpc = vi.hoisted(() => ({
  // The api helper already carries the `/api` prefix in its path.
  getApiBase: vi.fn(() => ''),
  getApiHeaders: vi.fn(async () => ({ 'x-loam-local-token': 'tok' })),
}));

vi.mock('@/services/rpc', () => rpc);

interface Call {
  url: string;
  method: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: (init?.method ?? 'GET').toUpperCase() };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch,
  );
}

const record = {
  sessionId: 's1',
  state: 'hibernated',
  hibernations: 2,
  lastReleasedEntries: 12,
  lastReleasedBytes: 2048,
};

describe('sessionHibernationApi', () => {
  beforeEach(() => {
    calls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the session hibernation snapshot', async () => {
    stubFetch(() => jsonResponse({ record, state: 'hibernated', msUntilHibernation: 42000, disabled: false }));
    const snap = await fetchSessionHibernation('s1', { Authorization: 'Bearer t' });
    expect(snap.state).toBe('hibernated');
    expect(snap.hibernations).toBe(2);
    expect(snap.lastReleasedEntries).toBe(12);
    expect(snap.lastReleasedBytes).toBe(2048);
    expect(snap.msUntilHibernation).toBe(42000);
    expect(snap.disabled).toBe(false);
    expect(calls[0]!.url).toContain('/api/sessions/s1/hibernation');
    expect(calls[0]!.method).toBe('GET');
  });

  it('defaults the counts when the session has no record yet', async () => {
    stubFetch(() => jsonResponse({ record: null, state: 'active', disabled: false }));
    const snap = await fetchSessionHibernation('s1');
    expect(snap.state).toBe('active');
    expect(snap.hibernations).toBe(0);
    expect(snap.lastReleasedEntries).toBe(0);
    expect(snap.msUntilHibernation).toBeUndefined();
  });

  it('url-encodes the session id', async () => {
    stubFetch(() => jsonResponse({ record: null, state: 'active', disabled: false }));
    await fetchSessionHibernation('a/b');
    expect(calls[0]!.url).toContain('/api/sessions/a%2Fb/hibernation');
  });

  it('requests immediate hibernation over POST', async () => {
    stubFetch(() => jsonResponse({ record, state: 'hibernated', releasedEntries: 12, releasedBytes: 2048 }));
    const res = await requestHibernation('s1');
    expect(res.state).toBe('hibernated');
    expect(res.releasedEntries).toBe(12);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/api/sessions/s1/hibernate');
  });

  it('wakes a hibernated session over POST', async () => {
    stubFetch(() => jsonResponse({ record: { ...record, state: 'active' }, state: 'active' }));
    const res = await wakeHibernatedSession('s1');
    expect(res.state).toBe('active');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/api/sessions/s1/wake');
  });

  it('adds the local auth headers when waking with auth', async () => {
    stubFetch(() => jsonResponse({ record, state: 'active' }));
    await wakeHibernatedSessionWithAuth('s1');
    expect(calls[0]!.url).toContain('/api/sessions/s1/wake');
    expect(rpc.getApiHeaders).toHaveBeenCalled();
  });

  it('surfaces the server error message', async () => {
    stubFetch(() => jsonResponse({ error: 'active-work' }, 409));
    await expect(fetchSessionHibernation('s1')).rejects.toThrow('active-work');
  });
});
