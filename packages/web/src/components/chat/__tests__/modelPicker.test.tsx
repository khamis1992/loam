// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

const directory = {
  models: [{ id: 'llama3:8b', name: 'llama3:8b', source: 'ollama', kind: 'ollama' }],
  sources: [{ source: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', count: 1 }],
  presets: [],
  active: { model: 'glm-5.3-flash:cloud', settingsModel: '', flex: { baseUrl: '', model: '', hasKey: false } },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderComposer() {
  return render(<Provider store={store}><Composer onSend={vi.fn()} /></Provider>);
}

describe('Composer real model picker', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/models')) return json(directory);
      if (url.endsWith('/api/model') && init?.method === 'PUT') return json({ ok: true, tier: 'standard', model: 'llama3:8b', needsKey: false });
      return json({}, 404);
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists real models and a custom provider without fictional tiers', async () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
    expect(await screen.findByText('llama3:8b')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Custom provider|مزوّد مخصص/ })).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${PRODUCT} 2.0`))).toBeNull();
  });

  it('persists the standard tier after picking a local model', async () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
    fireEvent.click(await screen.findByText('llama3:8b'));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('loam.composer.prefs') ?? '{}').tier).toBe('standard'));
    cleanup();
    renderComposer();
    expect(JSON.parse(localStorage.getItem('loam.composer.prefs') ?? '{}').tier).toBe('standard');
  });

  it('opens the inline custom-provider form without changing the tier', async () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Custom provider|مزوّد مخصص/ }));
    expect(await screen.findByPlaceholderText(/Provider base URL/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('loam.composer.prefs') ?? '{}').tier ?? 'standard').toBe('standard');
  });
});
