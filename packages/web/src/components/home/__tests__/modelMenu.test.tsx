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

describe('ModelMenu (fictional tiers removed — real picker only)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders real models and NO fictional tier rows', async () => {
    stubFetch((url) => (url === apiUrl('/models') ? json(directory) : json({}, 404)));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
    expect(await screen.findByText('llama3:8b')).toBeTruthy();
    expect(screen.getAllByText('glm-5.3-flash').length).toBeGreaterThanOrEqual(1);
    // The fictional tiers are gone entirely.
    expect(screen.queryByText(/Loam 2\.0 Max/)).toBeNull();
    expect(screen.queryByText(/^Loam 2\.0$/)).toBeNull();
    expect(screen.queryByText(/Loam 2\.0 Lite/)).toBeNull();
    // The custom-provider row replaced the fictional Flex tier item.
    expect(screen.getByRole('button', { name: /Custom provider|مزوّد مخصص/ })).toBeTruthy();
  });

  it('marks unreachable sources and filters by search', async () => {
    stubFetch((url) => (url === apiUrl('/models') ? json(directory) : json({}, 404)));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
    await screen.findByText('llama3:8b');
    expect(screen.getByText(/unreachable/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Search models/), { target: { value: 'glm' } });
    expect(screen.queryByText('llama3:8b')).toBeNull();
    expect(screen.getAllByText('glm-5.3-flash').length).toBeGreaterThanOrEqual(1);
  });

  it('picks a local model via PUT /api/model and fires the standard tier', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/models')) return json(directory);
      if (url === apiUrl('/model') && init?.method === 'PUT') {
        return json({ ok: true, tier: 'standard', model: 'llama3:8b', needsKey: false, active: directory.active });
      }
      return json({}, 404);
    });
    const onChange = vi.fn();
    render(<ModelMenu value="max" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
    fireEvent.click((await screen.findAllByText('glm-5.3-flash')).at(-1)!);
    expect(await screen.findByText(/needs an API key/)).toBeTruthy();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('flex'));
  });

  it('opens the Flex BYOK form from the custom-provider row and saves with a preset', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/models')) return json(directory);
      if (url === apiUrl('/model-tiers')) return json({ tiers: [], flex: { baseUrl: '', model: '', hasKey: false } });
      if (url === apiUrl('/model-tiers/flex') && init?.method === 'PUT') {
        return json({ ok: true, flex: { baseUrl: 'http://127.0.0.1:31415/v1', model: 'glm-5.3-flash', hasKey: true } });
      }
      return json({}, 404);
    });
    const onChange = vi.fn();
    render(<ModelMenu value="standard" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Model|النموذج|glm-5/ }));
    await screen.findByText('llama3:8b');
    fireEvent.click(screen.getByRole('button', { name: /Custom provider|مزوّد مخصص/ }));
    // Preset chip fills the base URL.
    fireEvent.click(await screen.findByText(/freellmapi \(موجّه ذاتي\)/));
    expect((screen.getByPlaceholderText(/Provider base URL/) as HTMLInputElement).value).toBe('http://127.0.0.1:31415/v1');
    fireEvent.change(screen.getByPlaceholderText(/Model id/), { target: { value: 'glm-5.3-flash' } });
    fireEvent.change(screen.getByPlaceholderText(/^API key$/), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/model-tiers/flex'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ baseUrl: 'http://127.0.0.1:31415/v1', model: 'glm-5.3-flash', key: 'sk-x' }),
        }),
      ),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('flex'));
  });

  it('degrades when the directory is unreachable: generic label, no list, custom-provider row still present', async () => {
    stubFetch(() => json({}, 500));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /^Model$|^النموذج$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Model$|^النموذج$/ }));
    expect(await screen.findByRole('button', { name: /Custom provider|مزوّد مخصص/ })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Search models/)).toBeNull();
  });

  it('shows the active real model on the trigger button once the directory loads', async () => {
    const withSettings = { ...directory, active: { ...directory.active, settingsModel: 'llama3:8b' } };
    stubFetch((url) => (url === apiUrl('/models') ? json(withSettings) : json({}, 404)));
    render(<ModelMenu value="standard" onChange={() => {}} />);
    expect(await screen.findByRole('button', { name: /llama3:8b/ })).toBeTruthy();
  });
});
