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
