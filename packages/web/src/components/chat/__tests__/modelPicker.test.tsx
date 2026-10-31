// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '@/store';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
}));
vi.mock('@/services/projectContextApi', () => ({
  fetchProjectBranch: async () => ({ branch: 'main' }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Composer } from '../Composer';
import { PRODUCT } from '@/i18n/t';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Provider store={store}>
      <Composer onSend={vi.fn()} {...props} />
    </Provider>,
  );
}

describe('Composer model picker (S15)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the model button without opening the advanced fold, and lists all modes', () => {
    renderComposer();
    const trigger = screen.getByRole('button', { name: new RegExp(`${PRODUCT} 2.0`) });
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.getByText(`${PRODUCT} 2.0 Max`)).toBeTruthy();
    expect(screen.getByText(`${PRODUCT} 2.0 Lite`)).toBeTruthy();
    expect(screen.getByText(`${PRODUCT} Flex`)).toBeTruthy();
  });

  it('picking Max persists the tier and a fresh composer mounts with Max preselected', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${PRODUCT} 2.0`) }));
    fireEvent.click(screen.getByText(`${PRODUCT} 2.0 Max`));
    expect(JSON.parse(localStorage.getItem('loam.composer.prefs') ?? '{}').tier).toBe('max');
    expect(screen.getByRole('button', { name: new RegExp(`${PRODUCT} 2.0 Max`) })).toBeTruthy();
    cleanup();
    renderComposer();
    expect(screen.getByRole('button', { name: new RegExp(`${PRODUCT} 2.0 Max`) })).toBeTruthy();
  });

  it('Flex opens the connectors settings (BYOK) instead of switching tier', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${PRODUCT} 2.0`) }));
    fireEvent.click(screen.getByText(`${PRODUCT} Flex`));
    expect(JSON.parse(localStorage.getItem('loam.composer.prefs') ?? '{}').tier ?? 'standard').toBe('standard');
    // The SettingsDialog lives in the app layout, not this bare render — assert
    // the store state the dispatch produced instead of the DOM.
    const ui = (store.getState() as { ui: { settingsOpen: boolean; settingsTab?: string } }).ui;
    expect(ui.settingsOpen).toBe(true);
    expect(ui.settingsTab).toBe('Connectors');
  });
});
