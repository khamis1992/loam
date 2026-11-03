import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteView } from '../RemoteView';
import { REMOTE_TOKEN_STORAGE_KEY } from '../remoteApi';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

interface Recorded {
  url: string;
  init?: RequestInit;
}

/** URL-aware fetch mock: exact-path handlers plus a default 404. Records calls. */
function mockFetch(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const handler = handlers[url];
    if (!handler) return jsonResponse(404, { error: `no mock for ${url}` });
    const { status, body } = handler(init);
    return jsonResponse(status, body);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const headersOf = (call: Recorded): Record<string, string> =>
  (call.init?.headers ?? {}) as Record<string, string>;

const listBody = {
  tasks: [
    {
      id: 'task-1',
      title: 'تقرير المبيعات',
      status: 'running',
      createdAt: '2026-10-29T07:00:00.000Z',
      updatedAt: '2026-10-29T08:00:00.000Z',
      messageCount: 4,
      stepCount: 3,
    },
    {
      id: 'task-2',
      title: 'مراجعة الكود',
      status: 'done',
      createdAt: '2026-10-28T07:00:00.000Z',
      updatedAt: '2026-10-28T09:00:00.000Z',
      messageCount: 2,
      stepCount: 1,
    },
  ],
};

const runningDetail = {
  task: {
    id: 'task-1',
    title: 'تقرير المبيعات',
    status: 'running',
    createdAt: '2026-10-29T07:00:00.000Z',
    updatedAt: '2026-10-29T08:00:00.000Z',
    messages: [
      { role: 'user', content: 'جهّز تقرير المبيعات', at: '2026-10-29T07:00:01.000Z' },
      { role: 'assistant', content: 'جارٍ التحليل… النتيجة: نمو 12%.', at: '2026-10-29T08:00:00.000Z' },
    ],
  },
  recovery: null,
};

const interruptedDetail = {
  task: {
    id: 'task-3',
    title: 'بحث السوق',
    status: 'interrupted',
    createdAt: '2026-10-29T06:00:00.000Z',
    updatedAt: '2026-10-29T06:30:00.000Z',
    messages: [{ role: 'assistant', content: 'توقفت بين الخطوات.', at: '2026-10-29T06:30:00.000Z' }],
  },
  recovery: { resumable: true, requiresConfirmation: true, completedSteps: 2 },
};

describe('RemoteView', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('shows the token entry screen first and calls nothing without a token', async () => {
    const { calls } = mockFetch({});
    render(<RemoteView />);

    expect(await screen.findByTestId('remote-token-input')).toBeInTheDocument();
    expect(screen.getByTestId('remote-token-submit')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('rejects a wrong token with an Arabic error and keeps the entry screen', async () => {
    mockFetch({ '/api/tasks': () => ({ status: 401, body: { error: 'unauthenticated' } }) });
    render(<RemoteView />);

    const input = await screen.findByTestId('remote-token-input');
    fireEvent.change(input, { target: { value: 'wrong-token' } });
    fireEvent.click(screen.getByTestId('remote-token-submit'));

    expect(await screen.findByTestId('remote-auth-error')).toHaveTextContent('المفتاح غير صحيح');
    expect(screen.queryByTestId('remote-task-list')).toBeNull();
    expect(window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('accepts a valid token (validated via token-gated GET /api/tasks) and renders the live list', async () => {
    const { calls } = mockFetch({ '/api/tasks': () => ({ status: 200, body: listBody }) });
    render(<RemoteView />);

    fireEvent.change(await screen.findByTestId('remote-token-input'), { target: { value: 'install-token-1' } });
    fireEvent.click(screen.getByTestId('remote-token-submit'));

    expect(await screen.findByText('تقرير المبيعات')).toBeInTheDocument();
    expect(screen.getByText('مراجعة الكود')).toBeInTheDocument();
    expect(screen.getByText('يعمل الآن')).toBeInTheDocument();
    expect(screen.getByText('مكتملة')).toBeInTheDocument();
    expect(window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY)).toBe('install-token-1');

    const listCall = calls.find((call) => call.url === '/api/tasks');
    expect(listCall).toBeDefined();
    expect(headersOf(listCall!)).toMatchObject({ 'x-loam-local-token': 'install-token-1' });
  });

  it('auto-loads the stored token, opens a task and stops it with the token header', async () => {
    window.localStorage.setItem(REMOTE_TOKEN_STORAGE_KEY, 'stored-token');
    let cancelHits = 0;
    const { calls } = mockFetch({
      '/api/tasks': () => ({ status: 200, body: listBody }),
      '/api/tasks/task-1': () => ({ status: 200, body: runningDetail }),
      '/api/tasks/task-1/cancel': () => { cancelHits += 1; return { status: 200, body: { ok: true, note: 'سيُوقف التنفيذ بين الخطوات' } }; },
    });
    render(<RemoteView />);

    fireEvent.click(await screen.findByTestId('remote-task-task-1'));

    // Detail: live status + latest messages from GET /api/tasks/:id.
    expect(await screen.findByText(/نمو 12%/)).toBeInTheDocument();
    expect(screen.getByText('أحدث المخرجات')).toBeInTheDocument();

    const detailCall = calls.find((call) => call.url === '/api/tasks/task-1');
    expect(detailCall).toBeDefined();
    expect(headersOf(detailCall!)).toMatchObject({ 'x-loam-local-token': 'stored-token' });

    fireEvent.click(screen.getByTestId('remote-stop'));
    await waitFor(() => expect(cancelHits).toBe(1));

    const cancelCall = calls.find((call) => call.url === '/api/tasks/task-1/cancel');
    expect(cancelCall).toBeDefined();
    expect(cancelCall!.init?.method).toBe('POST');
    expect(headersOf(cancelCall!)).toMatchObject({ 'x-loam-local-token': 'stored-token' });
    // A running task offers stop, not resume.
    expect(screen.queryByTestId('remote-resume')).toBeNull();
  });

  it('resumes an interrupted task and confirms the retry when the server demands it', async () => {
    window.localStorage.setItem(REMOTE_TOKEN_STORAGE_KEY, 'stored-token');
    const resumeBodies: Array<unknown> = [];
    const interruptedList = { tasks: [{ id: 'task-3', title: 'بحث السوق', status: 'interrupted', createdAt: '2026-10-29T06:00:00.000Z', updatedAt: '2026-10-29T06:30:00.000Z', messageCount: 1, stepCount: 2 }] };
    const { calls } = mockFetch({
      '/api/tasks': () => ({ status: 200, body: interruptedList }),
      '/api/tasks/task-3': () => ({ status: 200, body: interruptedDetail }),
      '/api/tasks/task-3/resume': (init) => {
        resumeBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return resumeBodies.length === 1
          ? { status: 409, body: { error: 'يلزم تأكيد إعادة المحاولة', requiresConfirmation: true } }
          : { status: 202, body: { taskId: 'task-3', status: 'queued' } };
      },
    });
    render(<RemoteView />);

    fireEvent.click(await screen.findByTestId('remote-task-task-3'));
    fireEvent.click(await screen.findByTestId('remote-resume'));

    // First attempt hit the replay-confirmation gate: offer the explicit retry.
    expect(await screen.findByTestId('remote-resume-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('remote-resume-confirm'));
    expect(await screen.findByTestId('remote-action-note')).toHaveTextContent('بدأ الاستئناف');

    const resumeCalls = calls.filter((call) => call.url === '/api/tasks/task-3/resume');
    expect(resumeCalls).toHaveLength(2);
    expect(resumeCalls[0]!.init?.method).toBe('POST');
    expect(headersOf(resumeCalls[0]!)).toMatchObject({ 'x-loam-local-token': 'stored-token' });
    expect(resumeBodies[1]).toMatchObject({ retryInterruptedStep: true });
    // An interrupted task offers resume, not stop.
    expect(screen.queryByTestId('remote-stop')).toBeNull();
  });

  it('falls back to the token screen when a stored token expires mid-session', async () => {
    window.localStorage.setItem(REMOTE_TOKEN_STORAGE_KEY, 'expired-token');
    mockFetch({ '/api/tasks': () => ({ status: 401, body: { error: 'unauthenticated' } }) });
    render(<RemoteView />);

    expect(await screen.findByTestId('remote-auth-error')).toHaveTextContent('انتهت صلاحية المفتاح');
    expect(window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY)).toBeNull();
  });
});
