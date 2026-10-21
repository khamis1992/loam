import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listSchedules, createSchedule, updateSchedule, deleteSchedule, runScheduleNow } from '../schedulesApi.js';

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

const sched = { id: 'sched_1', prompt: 'Summarize inbox', intervalSeconds: 3600, enabled: true };

describe('schedulesApi (automations CRUD)', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists automations via GET /api/schedules', async () => {
    stubFetch(() => jsonResponse({ schedules: [sched] }));
    const data = await listSchedules();
    expect(data.schedules).toHaveLength(1);
    expect(data.schedules![0]).toMatchObject({ id: 'sched_1', prompt: 'Summarize inbox' });
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/api/schedules'))).toBe(true);
  });

  it('creates an automation via POST /api/schedules with a JSON body', async () => {
    stubFetch(() => jsonResponse({ schedule: sched }, 201));
    await createSchedule({ prompt: 'Summarize inbox', intervalSeconds: 3600 });
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/schedules'));
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ prompt: 'Summarize inbox', intervalSeconds: 3600 });
    expect(post!.headers?.['content-type']).toBe('application/json');
  });

  it('updates an automation via PATCH /api/schedules/:id', async () => {
    stubFetch(() => jsonResponse({ schedule: { ...sched, prompt: 'New prompt', enabled: false } }));
    await updateSchedule('sched_1', { prompt: 'New prompt', enabled: false });
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/api/schedules/sched_1'));
    expect(patch).toBeTruthy();
    expect(patch!.body).toEqual({ prompt: 'New prompt', enabled: false });
  });

  it('deletes an automation via DELETE /api/schedules/:id', async () => {
    stubFetch(() => jsonResponse({ deleted: true }));
    await deleteSchedule('sched_1');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/schedules/sched_1'))).toBe(true);
  });

  it('runs an automation now via POST /api/schedules/:id/run-now', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    await runScheduleNow('sched_1');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/schedules/sched_1/run-now'))).toBe(true);
  });

  it('percent-encodes the automation id in the path', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    await runScheduleNow('a/b c');
    expect(calls[0]!.url).toContain(encodeURIComponent('a/b c'));
  });

  it('throws the server error message on failure', async () => {
    stubFetch(() => jsonResponse({ error: 'schedule not found' }, 404));
    await expect(updateSchedule('nope', { enabled: true })).rejects.toThrow('schedule not found');
  });
});
