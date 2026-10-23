import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RUNTIME_POLL_MS, useSessionRuntime } from '../useSessionRuntime';

/** Module-namespace stub: the hook imports these bindings directly, so spying
 *  on the imported module object is not enough for ESM. */
const api = vi.hoisted(() => ({
  fetchSessionRuntime: vi.fn(),
  raiseSessionBudgetDefault: vi.fn(),
  wakeSession: vi.fn(),
}));

vi.mock('@/services/sessionRuntimeApi', () => api);
vi.mock('@/services/rpc', () => ({ getApiHeaders: vi.fn(async () => ({})) }));

const budget = (overrides: Record<string, unknown> = {}) => ({
  steps: 8,
  stepLimit: 10,
  tokens: 0,
  tokenLimit: 100,
  percent: 80,
  stopped: false,
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  state: 'idle',
  sleeping: false,
  budget: budget(),
  raised: false,
  ...overrides,
});

const respond = (session: unknown) => ({ session, defaults: { idleMinutes: 30, stepLimit: 40, tokenLimit: 500000 } });

describe('useSessionRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('polls the runtime endpoint on mount and on the interval', async () => {
    api.fetchSessionRuntime.mockResolvedValue(respond(snapshot()));
    const { result } = renderHook(() => useSessionRuntime('s1', { pollMs: RUNTIME_POLL_MS }));

    await waitFor(() => expect(result.current.snapshot?.sessionId).toBe('s1'));
    expect(result.current.loading).toBe(false);
    expect(api.fetchSessionRuntime).toHaveBeenCalledTimes(1);
    expect(api.fetchSessionRuntime.mock.calls[0]![0]).toBe('s1');

    await act(async () => {
      vi.advanceTimersByTime(RUNTIME_POLL_MS);
    });
    expect(api.fetchSessionRuntime.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops polling when disabled', async () => {
    api.fetchSessionRuntime.mockResolvedValue(respond(snapshot()));
    renderHook(() => useSessionRuntime('s1', { enabled: false }));
    await act(async () => {
      vi.advanceTimersByTime(RUNTIME_POLL_MS * 3);
    });
    expect(api.fetchSessionRuntime).not.toHaveBeenCalled();
  });

  it('survives a failed poll without throwing', async () => {
    api.fetchSessionRuntime.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useSessionRuntime('s1'));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.snapshot).toBeUndefined();
  });

  it('raiseBudget clears the stop flag and updates the snapshot', async () => {
    api.fetchSessionRuntime.mockResolvedValue(respond(snapshot({ budget: budget({ steps: 10, stepLimit: 10, percent: 100, stopped: true }) })));
    api.raiseSessionBudgetDefault.mockResolvedValue(
      respond(snapshot({ budget: budget({ steps: 10, stepLimit: 50, tokenLimit: 600000, percent: 20, stopped: false }), raised: true })),
    );

    const { result } = renderHook(() => useSessionRuntime('s1'));
    await waitFor(() => expect(result.current.snapshot?.budget.stopped).toBe(true));

    await act(async () => {
      await result.current.raiseBudget();
    });
    expect(api.raiseSessionBudgetDefault).toHaveBeenCalledWith('s1');
    expect(result.current.snapshot?.budget.stopped).toBe(false);
    expect(result.current.snapshot?.raised).toBe(true);
  });

  it('wake clears the sleeping state', async () => {
    api.fetchSessionRuntime.mockResolvedValue(respond(snapshot({ state: 'sleeping', sleeping: true })));
    api.wakeSession.mockResolvedValue(respond(snapshot({ state: 'awake', sleeping: false })));

    const { result } = renderHook(() => useSessionRuntime('s1'));
    await waitFor(() => expect(result.current.snapshot?.sleeping).toBe(true));

    await act(async () => {
      await result.current.wake();
    });
    expect(api.wakeSession).toHaveBeenCalledWith('s1', expect.anything());
    expect(result.current.snapshot?.sleeping).toBe(false);
  });
});
