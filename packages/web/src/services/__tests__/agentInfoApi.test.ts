import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('../rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({ Authorization: 'Bearer t' }),
}));

import {
  addScratchpadItem,
  addWatch,
  bindChannel,
  completeScratchpadItem,
  deleteWatch,
  getAgentMemory,
  getLiveViewFrame,
  getLiveViewStatus,
  listApprovalRules,
  listChannelBindings,
  listChannelStatus,
  listChildren,
  listSchedules,
  listScratchpad,
  listWatches,
  removeApprovalRule,
  runScheduleNow,
  unbindChannel,
} from '../agentInfoApi.js';

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

const enc = encodeURIComponent;

describe('agentInfoApi', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads memory, approval rules and scratchpad, defaulting to [] when absent', async () => {
    stubFetch((c) => {
      if (c.url.endsWith('/memory')) return jsonResponse({ entries: [{ id: 'm1', text: 'loves tests' }] });
      if (c.url.includes('/approval-rules')) return jsonResponse({ rules: [{ id: 'r1', tool: 'bash', decision: 'allow', createdAt: 'now' }] });
      return jsonResponse({});
    });

    const memory = await getAgentMemory('a1');
    expect(memory).toEqual([{ id: 'm1', text: 'loves tests' }]);

    const rules = await listApprovalRules('a1');
    expect(rules[0]).toMatchObject({ tool: 'bash', decision: 'allow' });

    await expect(listScratchpad('a1')).resolves.toEqual([]);
    expect(calls.some((c) => c.url === `${API}/api/agents/${enc('a1')}/scratchpad`)).toBe(true);
  });

  it('creates and completes scratchpad items with the right methods and bodies', async () => {
    stubFetch(() => jsonResponse({}));
    await addScratchpadItem('a1', 'remember the milk');
    await completeScratchpadItem('a1', 's1');

    const add = calls.find((c) => c.url === `${API}/api/agents/${enc('a1')}/scratchpad`);
    expect(add!.method).toBe('POST');
    expect(add!.body).toEqual({ text: 'remember the milk' });
    expect(add!.headers?.['content-type']).toBe('application/json');

    const done = calls.find((c) => c.url === `${API}/api/agents/${enc('a1')}/scratchpad/${enc('s1')}/complete`);
    expect(done).toBeTruthy();
    expect(done!.method).toBe('POST');
  });

  it('deletes an approval rule by id', async () => {
    stubFetch(() => jsonResponse({}));
    await removeApprovalRule('r1');
    const del = calls.find((c) => c.url === `${API}/api/approval-rules/${enc('r1')}`);
    expect(del!.method).toBe('DELETE');
  });

  it('manages URL watches: list, create and delete', async () => {
    stubFetch((c) => {
      if (c.method === 'DELETE') return jsonResponse({});
      if (c.method === 'POST') return jsonResponse({});
      return jsonResponse({ watches: [{ id: 'w1', url: 'https://x.test', intervalMinutes: 30, prompt: 'check', enabled: true }] });
    });

    const watches = await listWatches('a1');
    expect(watches[0]).toMatchObject({ id: 'w1', intervalMinutes: 30 });

    const draft = { url: 'https://y.test', intervalMinutes: 15, selector: '#main', prompt: 'watch' };
    await addWatch('a1', draft);
    const add = calls.find((c) => c.url === `${API}/api/agents/${enc('a1')}/watches` && c.method === 'POST');
    expect(add).toBeTruthy();
    expect(add!.body).toEqual(draft);

    await deleteWatch('w1');
    expect(calls.find((c) => c.url === `${API}/api/watches/${enc('w1')}`)!.method).toBe('DELETE');
  });

  it('lists schedules and triggers a run-now', async () => {
    stubFetch((c) => {
      if (c.url.includes('/run-now')) return jsonResponse({});
      return jsonResponse({ schedules: [{ id: 'sc1', prompt: 'daily', intervalSeconds: 3600, enabled: true }] });
    });

    const schedules = await listSchedules('a1');
    expect(schedules[0]).toMatchObject({ id: 'sc1', intervalSeconds: 3600 });

    await runScheduleNow('sc1');
    expect(calls.find((c) => c.url === `${API}/api/schedules/${enc('sc1')}/run-now`)!.method).toBe('POST');
  });

  it('lists channel status, bindings, and binds/unbinds a channel', async () => {
    stubFetch((c) => {
      if (c.url === `${API}/api/channels`) return jsonResponse({ channels: [{ name: 'telegram', configured: true, envVarNames: [] }] });
      if (c.method === 'POST') return jsonResponse({ binding: { id: 'b1', channel: 'telegram', chatId: '42', agentId: 'a1', createdAt: 'now' } });
      if (c.method === 'DELETE') return jsonResponse({});
      return jsonResponse({ bindings: [{ id: 'b1', channel: 'telegram', chatId: '42', agentId: 'a1', createdAt: 'now' }] });
    });

    const status = await listChannelStatus();
    expect(status[0]).toMatchObject({ name: 'telegram', configured: true });

    const bindings = await listChannelBindings('a1');
    expect(bindings[0]).toMatchObject({ channel: 'telegram', chatId: '42' });

    const bound = await bindChannel('a1', 'telegram', '42');
    expect(bound.id).toBe('b1');
    const bind = calls.find((c) => c.url === `${API}/api/agents/${enc('a1')}/channels` && c.method === 'POST');
    expect(bind!.body).toEqual({ channel: 'telegram', chatId: '42' });

    await unbindChannel('a1', 'b1');
    expect(
      calls.find((c) => c.url === `${API}/api/agents/${enc('a1')}/channels/${enc('b1')}`)!.method,
    ).toBe('DELETE');
  });

  it('lists child agents and the live computer preview status/frame', async () => {
    stubFetch((c) => {
      if (c.url.endsWith('/children')) {
        return jsonResponse({ children: [{ childId: 'c1', spawnKey: 'k', name: 'Kid', emoji: '👶', description: '', archived: false, createdAt: 'now' }] });
      }
      if (c.url.includes('/live-view/status')) return jsonResponse({ screen: { available: true, running: false }, browser: { available: false, url: null } });
      if (c.url.includes('/live-view/frame')) return jsonResponse({ frame: { source: 'screen', data: 'abc', mediaType: 'image/png', at: 1, width: 10, height: 10, url: null, title: null } });
      return jsonResponse({});
    });

    const children = await listChildren('a1');
    expect(children[0]).toMatchObject({ childId: 'c1', name: 'Kid' });

    const live = await getLiveViewStatus('t1');
    expect(live.screen).toMatchObject({ available: true, running: false });

    const frame = await getLiveViewFrame('t1');
    expect(frame).toMatchObject({ source: 'screen', data: 'abc', width: 10 });
    expect(calls.some((c) => c.url.includes('source=screen'))).toBe(true);
  });

  it('defaults a missing live frame to null', async () => {
    stubFetch(() => jsonResponse({}));
    await expect(getLiveViewFrame('t1')).resolves.toBeNull();
  });

  it('throws the server error message on a failed request', async () => {
    stubFetch(() => jsonResponse({ error: 'agent not found' }, 404));
    await expect(getAgentMemory('missing')).rejects.toThrow('agent not found');
  });
});
