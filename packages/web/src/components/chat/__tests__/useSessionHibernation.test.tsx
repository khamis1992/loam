import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HIBERNATION_POLL_MS, useSessionHibernation } from '../useSessionHibernation';
import { getDerivedChatState, hasDerivedChatState, resetDerivedChatState } from '../hibernationStore';

/** Module-namespace stub: the hook imports these bindings directly. */
const api = vi.hoisted(() => ({
  fetchSessionHibernation: vi.fn(),
  requestHibernation: vi.fn(),
  wakeHibernatedSessionWithAuth: vi.fn(),
}));

vi.mock('@/services/sessionHibernationApi', () => api);
vi.mock('@/services/rpc', () => ({ getApiHeaders: vi.fn(async () => ({})) }));

const events = [{ type: 'message', id: '1' } as never];

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  state: 'active',
  hibernations: 0,
  lastReleasedEntries: 0,
  lastReleasedBytes: 0,
  disabled: false,
  ...overrides,
});

describe('useSessionHibernation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDerivedChatState();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('builds the derived fold on mount and polls the daemon', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot());
    const { result } = renderHook(() => useSessionHibernation('s1', events));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.fetchSessionHibernation).toHaveBeenCalledTimes(1);
    expect(hasDerivedChatState('s1')).toBe(true);
    expect(getDerivedChatState('s1')?.entries).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(HIBERNATION_POLL_MS);
    });
    expect(api.fetchSessionHibernation.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('hibernate asks the daemon and releases the local derived fold', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot({ state: 'hibernated', hibernations: 1 }));
    api.requestHibernation.mockResolvedValue({ record: null, state: 'hibernated' });
    const { result } = renderHook(() => useSessionHibernation('s1', events));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(hasDerivedChatState('s1')).toBe(true);

    await act(async () => {
      await result.current.hibernate();
    });

    expect(api.requestHibernation).toHaveBeenCalledWith('s1', expect.anything());
    expect(hasDerivedChatState('s1')).toBe(false);
    expect(result.current.hibernated).toBe(true);
  });

  it('the first keystroke wakes without an empty draft waking first', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot({ state: 'hibernated', hibernations: 1 }));
    api.wakeHibernatedSessionWithAuth.mockResolvedValue({ record: null, state: 'active' });
    const { result } = renderHook(() => useSessionHibernation('s1', events));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // An active session is not woken by typing.
    await act(async () => {
      await result.current.onFirstInput('h');
    });
    expect(api.wakeHibernatedSessionWithAuth).not.toHaveBeenCalled();

    // Once hibernated, the first real character wakes the session.
    await act(async () => {
      await result.current.hibernate();
    });
    expect(result.current.hibernated).toBe(true);

    api.fetchSessionHibernation.mockResolvedValue(snapshot({ state: 'active' }));
    await act(async () => {
      await result.current.onFirstInput('hello');
    });
    expect(api.wakeHibernatedSessionWithAuth).toHaveBeenCalledWith('s1');
    expect(result.current.hibernated).toBe(false);
    // The fold is rebuilt from the canonical events, not from the draft.
    expect(hasDerivedChatState('s1')).toBe(true);
  });

  it('never releases before the idle threshold', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot());
    const { result } = renderHook(() => useSessionHibernation('s1', events, { idleMs: 60_000, pollMs: HIBERNATION_POLL_MS }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(api.requestHibernation).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(api.requestHibernation).toHaveBeenCalledTimes(1);
  });

  it('a background tab never releases by itself', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot());
    const { result } = renderHook(() => useSessionHibernation('s1', events, { idleMs: 1000, pollMs: HIBERNATION_POLL_MS }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(api.requestHibernation).not.toHaveBeenCalled();
    hidden.mockRestore();
  });

  it('a disabled daemon setting stops the local release too', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot({ disabled: true }));
    const { result } = renderHook(() => useSessionHibernation('s1', events, { idleMs: 1000, pollMs: HIBERNATION_POLL_MS }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(api.requestHibernation).not.toHaveBeenCalled();
  });

  it('survives a failed release without throwing', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot());
    api.requestHibernation.mockRejectedValue(new Error('active-work'));
    const { result } = renderHook(() => useSessionHibernation('s1', events));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.hibernate();
    });
    expect(result.current.error).toBe('active-work');
  });

  it('stops polling when disabled', async () => {
    api.fetchSessionHibernation.mockResolvedValue(snapshot());
    renderHook(() => useSessionHibernation('s1', events, { enabled: false }));
    await act(async () => {
      vi.advanceTimersByTime(HIBERNATION_POLL_MS * 3);
    });
    expect(api.fetchSessionHibernation).not.toHaveBeenCalled();
  });
});
