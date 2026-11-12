import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const browser = vi.hoisted(() => ({
  supported: false,
  current: {
    attached: false,
    visible: false,
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  },
  iabAttach: vi.fn(),
  iabDetach: vi.fn(),
  iabNavigate: vi.fn(),
  iabGetState: vi.fn(),
  iabSetVisible: vi.fn(),
  iabSetBounds: vi.fn(),
}));

vi.mock('@/lib/inAppBrowser', () => ({
  isInAppBrowserSupported: () => browser.supported,
  iabAttach: browser.iabAttach,
  iabDetach: browser.iabDetach,
  iabNavigate: browser.iabNavigate,
  iabGetState: browser.iabGetState,
  iabSetVisible: browser.iabSetVisible,
  iabSetBounds: browser.iabSetBounds,
  iabBack: vi.fn(),
  iabForward: vi.fn(),
  iabReload: vi.fn(),
  iabOnStateChanged: () => () => undefined,
}));

vi.mock('@/services/desktopApis', () => ({
  desktopApis: { system: { openExternal: vi.fn() } },
}));

import { TaskBrowserPanel } from '../TaskBrowserPanel';

class ObserverStub {
  observe() {}
  disconnect() {}
}

class IntersectionStub {
  constructor(private callback: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) {}
  observe() {
    this.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
  }
  disconnect() {}
}

describe('TaskBrowserPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ObserverStub);
    vi.stubGlobal('IntersectionObserver', IntersectionStub);
    browser.iabAttach.mockImplementation(() => {
      browser.current = { ...browser.current, attached: true };
      return Promise.resolve(browser.current);
    });
    browser.iabNavigate.mockImplementation((url: string) => {
      browser.current = { ...browser.current, attached: true, url, title: url };
      return Promise.resolve({ ok: true });
    });
    browser.iabGetState.mockImplementation(() => Promise.resolve(browser.current));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    browser.supported = false;
    browser.current = { attached: false, visible: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
  });

  it('opens a URL outside when the native desktop browser is unavailable', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<TaskBrowserPanel />);

    const input = screen.getAllByRole('textbox', { name: 'Search Google or enter a URL' })[0];
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer'));
    expect(browser.iabAttach).not.toHaveBeenCalled();
  });

  it('uses the native Electron browser and normalizes search input', async () => {
    browser.supported = true;
    render(<TaskBrowserPanel />);
    screen.getByTestId('task-browser-surface').getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 600, width: 500, height: 600,
      toJSON: () => ({}),
    }) as DOMRect;

    const input = screen.getAllByRole('textbox', { name: 'Search Google or enter a URL' })[0];
    fireEvent.change(input, { target: { value: 'Loam automation' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(browser.iabNavigate).toHaveBeenCalledWith('https://www.google.com/search?q=Loam%20automation'));
    expect(browser.iabAttach).toHaveBeenCalled();
    expect(browser.iabSetBounds).toHaveBeenCalled();
    await waitFor(() => expect(browser.iabSetVisible).toHaveBeenCalledWith(true));
  });
});
