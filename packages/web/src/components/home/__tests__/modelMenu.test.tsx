import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('@/services/rpc', () => ({ getApiBase: () => API, getApiHeaders: async () => ({}) }));

import { ModelMenu } from '../ModelMenu';

const apiUrl = (p: string) => `${API}/api${p}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('ModelMenu (model-tier mapping)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists all four model tiers and calls back with the chosen tier', async () => {
    const onChange = vi.fn();
    render(<ModelMenu value="standard" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam 2.0' }));
    expect(await screen.findByText(/Max/)).toBeTruthy();
    expect(screen.getByText(/Lite/)).toBeTruthy();
    expect(screen.getByText(/Flex/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Loam 2\.0 Lite/ }));
    expect(onChange).toHaveBeenCalledWith('lite');
  });

  it('loads Flex BYOK state and saves a new key via PUT /api/model-tiers/flex', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/model-tiers') && init?.method !== 'PUT') {
        return json({ tiers: [], flex: { baseUrl: 'https://api.example/v1', model: 'their-llm', hasKey: true } });
      }
      if (url === apiUrl('/model-tiers/flex') && init?.method === 'PUT') {
        return json({ ok: true, flex: { baseUrl: 'https://api.example/v1', model: 'their-llm', hasKey: true } });
      }
      return json({}, 404);
    });
    render(<ModelMenu value="flex" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam Flex' }));
    expect(await screen.findByText(/Key saved/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Provider base URL/), { target: { value: 'https://api.example/v1' } });
    fireEvent.change(screen.getByPlaceholderText(/Model id/), { target: { value: 'their-llm' } });
    fireEvent.change(screen.getByPlaceholderText(/New key/), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/model-tiers/flex'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ baseUrl: 'https://api.example/v1', model: 'their-llm', key: 'sk-new' }),
        }),
      ),
    );
  });

  it('removes the stored Flex key via DELETE /api/model-tiers/flex/key', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/model-tiers') && init?.method !== 'DELETE') {
        return json({ tiers: [], flex: { baseUrl: 'https://api.example/v1', model: 'their-llm', hasKey: true } });
      }
      if (url === apiUrl('/model-tiers/flex/key') && init?.method === 'DELETE') {
        return json({ cleared: true, flex: { baseUrl: 'https://api.example/v1', model: 'their-llm', hasKey: false } });
      }
      return json({}, 404);
    });
    render(<ModelMenu value="flex" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam Flex' }));
    fireEvent.click(await screen.findByRole('button', { name: /Remove key/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(apiUrl('/model-tiers/flex/key'), expect.objectContaining({ method: 'DELETE' })),
    );
  });
});

describe('ModelMenu (real model directory)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const directory = {
    models: [
      { id: 'llama3:8b', name: 'llama3:8b', source: 'ollama', kind: 'ollama' as const },
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash', source: 'freellmapi', kind: 'openai-compatible' as const },
    ],
    sources: [
      { source: 'ollama', label: 'Ollama (محلي)', kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', count: 1 },
      { source: 'freellmapi', label: 'freellmapi (http://127.0.0.1:31415/v1)', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:31415/v1', count: 1 },
      { source: 'openrouter', label: 'openrouter (https://openrouter.ai/api/v1)', kind: 'openai-compatible' as const, baseUrl: 'https://openrouter.ai/api/v1', error: 'HTTP 401', count: 0 },
    ],
    presets: [
      { id: 'freellmapi', label: 'freellmapi (موجّه ذاتي)', baseUrl: 'http://127.0.0.1:31415/v1', keyEnv: 'FREELLM_API_KEY', setupAr: 'شغّل الموجّه محليًا.' },
    ],
    active: { model: 'glm-5.3-flash:cloud', settingsModel: '', flex: { baseUrl: '', model: '', hasKey: false } },
  };

  it('lists reachable real models grouped by source and marks unreachable ones', async () => {
    stubFetch((url) => (url === apiUrl('/models') ? json(directory) : json({}, 404)));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam 2.0' }));
    expect(await screen.findByText('llama3:8b')).toBeTruthy();
    // The trigger button also carries the active model name — scope to the list.
    expect(screen.getAllByText('glm-5.3-flash').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/unreachable/)).toBeTruthy();
  });

  it('filters by search query', async () => {
    stubFetch((url) => (url === apiUrl('/models') ? json(directory) : json({}, 404)));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam 2.0' }));
    await screen.findByText('llama3:8b');
    fireEvent.change(screen.getByPlaceholderText(/Search models/), { target: { value: 'glm' } });
    expect(screen.queryByText('llama3:8b')).toBeNull();
    expect(screen.getAllByText('glm-5.3-flash').length).toBeGreaterThanOrEqual(1);
  });

  it('picks a local model via PUT /api/model and switches the tier to standard', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/models')) return json(directory);
      if (url === apiUrl('/model') && init?.method === 'PUT') {
        return json({ ok: true, tier: 'standard', model: 'llama3:8b', needsKey: false, active: directory.active });
      }
      return json({}, 404);
    });
    const onChange = vi.fn();
    render(<ModelMenu value="max" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam 2.0 Max' }));
    fireEvent.click(await screen.findByText('llama3:8b'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/model'),
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ id: 'llama3:8b', source: 'ollama' }) }),
      ),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('standard'));
  });

  it('picks a cloud model and surfaces the missing-key notice', async () => {
    stubFetch((url, init) => {
      if (url === apiUrl('/models')) return json(directory);
      if (url === apiUrl('/model') && init?.method === 'PUT') {
        return json({ ok: true, tier: 'flex', model: 'glm-5.3-flash:cloud', needsKey: true, active: directory.active });
      }
      return json({}, 404);
    });
    const onChange = vi.fn();
    render(<ModelMenu value="standard" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam 2.0' }));
    // The trigger also shows the active model name; the row is the last match.
    const row = (await screen.findAllByText('glm-5.3-flash')).at(-1)!;
    fireEvent.click(row);
    expect(await screen.findByText(/needs an API key/)).toBeTruthy();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('flex'));
  });

  it('degrades to tiers only when the directory is unreachable', async () => {
    stubFetch(() => json({}, 500));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Loam 2.0' }));
    expect(await screen.findByText(/Max/)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Search models/)).toBeNull();
  });

  it('shows the active real model on the trigger button once the directory loads', async () => {
    const withSettings = { ...directory, active: { ...directory.active, settingsModel: 'llama3:8b' } };
    stubFetch((url) => (url === apiUrl('/models') ? json(withSettings) : json({}, 404)));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    expect(await screen.findByRole('button', { name: /llama3:8b/ })).toBeTruthy();
  });
});
