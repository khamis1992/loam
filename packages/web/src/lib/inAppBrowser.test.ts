import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  iabAttach,
  iabDetach,
  iabBack,
  iabGetState,
  iabNavigate,
  iabOnStateChanged,
  iabSetBounds,
  isInAppBrowserSupported,
} from './inAppBrowser';

const state = {
  attached: true,
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  canGoBack: true,
  canGoForward: false,
};

function withBridge(api: Record<string, unknown>, events: Record<string, unknown> = {}) {
  (window as unknown as Record<string, unknown>).__apis = { inAppBrowser: api };
  (window as unknown as Record<string, unknown>).__events = { inAppBrowser: events };
}

afterEach(() => {
  delete (window as unknown as { __apis?: unknown }).__apis;
  delete (window as unknown as { __events?: unknown }).__events;
});

describe('inAppBrowser bridge', () => {
  it('reports unsupported when the preload bridge is absent', () => {
    expect(isInAppBrowserSupported()).toBe(false);
  });

  it('reports supported and forwards calls when the bridge is present', async () => {
    const navigate = vi.fn(async (url: string) => ({ ok: true, url }));

    withBridge({
      attach: vi.fn(async () => state),
      navigate,
    });
    expect(isInAppBrowserSupported()).toBe(true);
    expect(await iabAttach()).toEqual(state);
    expect((await iabNavigate('https://x.dev')).ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith('https://x.dev');
  });

  it('falls back to safe defaults for every method when absent', async () => {
    expect(await iabAttach()).toBeUndefined();
    expect(await iabDetach()).toBeUndefined();
    expect(await iabBack()).toBeUndefined();
    expect((await iabNavigate('https://x.dev')).ok).toBe(false);
    expect((await iabGetState()).attached).toBe(false);
    expect(await iabSetBounds({ x: 0, y: 0, width: 10, height: 10 })).toBe(false);
    expect(await iabOnStateChanged(() => undefined)).toBeTypeOf('function');
  });

  it('subscribes to pushed state changes through the events bridge', () => {
    let listener: ((s: unknown) => void) | null = null;
    withBridge(
      {},
      { onStateChanged: (cb: (s: unknown) => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      } },
    );
    const cb = vi.fn();
    const off = iabOnStateChanged(cb);
    listener?.(state);
    expect(cb).toHaveBeenCalledWith(state);
    off();
    expect(listener).toBeNull();
  });
});
