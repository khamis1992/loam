import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useOnline } from './useOnline.js';

describe('useOnline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('stays hidden while online', () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current.online).toBe(true);
    expect(result.current.showBanner).toBe(false);
  });

  it('shows the banner after the 10 s grace period when offline, then hides on recovery', () => {
    const { result } = renderHook(() => useOnline());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(result.current.online).toBe(false);
    expect(result.current.showBanner).toBe(false);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.showBanner).toBe(true);
    expect(result.current.wasOffline).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(result.current.online).toBe(true);
    expect(result.current.showBanner).toBe(false);
    expect(result.current.wasOffline).toBe(true);
  });

  it('does not show the banner if connectivity is restored inside the grace window', () => {
    const { result } = renderHook(() => useOnline());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.showBanner).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(result.current.showBanner).toBe(false);
  });
});
