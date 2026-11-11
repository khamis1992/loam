import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://loam.test',
  getApiHeaders: async () => ({ Authorization: 'Bearer test' }),
}));

import { listCompanionDevices, startCompanionTask } from '../companionsApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('companionsApi', () => {
  it('normalizes provider availability and creates an own-device task', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/tasks/draft')) {
        return new Response(JSON.stringify({ task: { id: 'task-1', title: 'Report', status: 'cancelled' } }), { status: 201 });
      }
      if (url.endsWith('/api/chat')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({
        devices: [],
        templates: [],
        goldenReady: true,
        wsl: true,
        hyperv: false,
        fake: false,
        wslDistros: ['Ubuntu-24.04'],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const devices = await listCompanionDevices();
    expect(devices.providers).toEqual({ wsl: true, hyperv: false, fake: false, wslDistros: ['Ubuntu-24.04'] });

    const task = await startCompanionTask('agent-1', 'Report');
    expect(task.id).toBe('task-1');
    expect(calls[1]?.url).toBe('http://loam.test/api/tasks/draft');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ title: 'Report', mode: 'code', agentId: 'agent-1' });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      taskId: 'task-1',
      prompt: 'Report',
      agentId: 'agent-1',
      workMode: 'own_device',
      mode: 'code',
    });
  });
});
