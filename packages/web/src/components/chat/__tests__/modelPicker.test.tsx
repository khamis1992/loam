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

const directory = {
  models: [
    { id: 'llama3:8b', name: 'llama3:8b', source: 'ollama', kind: 'ollama' },
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash', source: 'freellmapi', kind: 'openai-compatible' },
  ],
  sources: [
    { source: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', count: 1 },
    { source: 'freellmapi', label: 'freellmapi', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:31415/v1', count: 1 },
  ],
  presets: [],
  active: { model: '', settingsModel: '', flex: { baseUrl: '', model: '', hasKey: false } },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubModels() {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return json(directory);
    if (url.endsWith('/api/model') && init?.method === 'PUT') return json({ ok: true, tier: 'standard', model: 'llama3:8b', needsKey: false, active: directory.active });
    if (url.endsWith('/api/model-tiers')) return json({ tiers: [], flex: directory.active.flex });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(<Provider store={store}><Composer onSend={vi.fn()} {...props} /></Provider>);
}

describe('Composer real model picker', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    stubModels();
  });
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists real models without opening the advanced fold or showing fictional tiers', async () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /^Model$|^النموذج$/ }));
    expect(await screen.findByText('llama3:8b')).toBeTruthy();
    expect(screen.getByText('glm-5.3-flash')).toBeTruthy();
    expect(screen.queryByText(/Loam 2\.0/)).toBeNull();
    expect(screen.getByRole('button', { name: /Custom provider|مزوّد مخصص/ })).toBeTruthy();
  });

  it('persists the real local model and the standard tier across composers', async () => {
    const fetchMock = stubModels();
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /^Model$|^النموذج$/ }));
    fireEvent.click(await screen.findByText('llama3:8b'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/api/model', expect.objectContaining({ method: 'PUT' })));
    expect(JSON.parse(localStorage.getItem('loam.composer.prefs') ?? '{}').tier).toBe('standard');
    expect(sessionStorage.getItem('loam-run-model')).toBe('llama3:8b');
    cleanup();
    renderComposer();
    expect(await screen.findByRole('button', { name: /llama3:8b/ })).toBeTruthy();
  });

  it('opens the custom-provider form instead of changing tier or opening connectors', async () => {
    renderComposer();
    const settingsBefore = (store.getState() as { ui: unknown }).ui;
    fireEvent.click(screen.getByRole('button', { name: /^Model$|^النموذج$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Custom provider|مزوّد مخصص/ }));
    expect(await screen.findByPlaceholderText(/Provider base URL/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('loam.composer.prefs') ?? '{}').tier ?? 'standard').toBe('standard');
    expect((store.getState() as { ui: unknown }).ui).toEqual(settingsBefore);
  });
});
