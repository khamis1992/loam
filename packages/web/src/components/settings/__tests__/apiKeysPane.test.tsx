import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store, openSettings } from '@/store';
import { SettingsDialog } from '../SettingsDialog';
import { ApiKeysPane } from '../ApiKeysPane';
import { setLocale } from '@/i18n/t';

interface Call { url: string; method: string; body?: Record<string, unknown> }

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: Call = { url, method, body };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch);
}

const keyRow = {
  id: 'key_1',
  name: 'my-script',
  prefix: 'lm_live_abcd',
  createdAt: '2026-01-02T03:04:05.000Z',
};

const emptyKeys = () => jsonResponse({ keys: [] });

describe('ApiKeysPane', () => {
  beforeEach(() => {
    calls = [];
    setLocale('en');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists masked keys from GET /api/api-keys', async () => {
    stubFetch((c) => (c.method === 'GET' ? jsonResponse({ keys: [keyRow] }) : jsonResponse({})));
    render(<ApiKeysPane />);
    expect(await screen.findByText('my-script')).toBeInTheDocument();
    expect(screen.getByText(/lm_live_abcd…/)).toBeInTheDocument();
    expect(screen.getByText(/Active/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/api/api-keys'))).toBe(true);
  });

  it('creates a key via POST /api/api-keys and shows the raw key once', async () => {
    stubFetch((c) => {
      if (c.method === 'POST') {
        return jsonResponse({ ...keyRow, key: 'lm_live_RAWKEY', keys: [{ ...keyRow, key: undefined }] }, 201);
      }
      return emptyKeys();
    });
    render(<ApiKeysPane />);
    fireEvent.change(screen.getByPlaceholderText('e.g. my-script'), { target: { value: 'my-script' } });
    fireEvent.click(screen.getByRole('button', { name: /Create key/ }));
    expect(await screen.findByDisplayValue('lm_live_RAWKEY')).toBeInTheDocument();
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/api-keys'));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({ name: 'my-script' });
    });
  });

  it('revokes a key via POST /api/api-keys/:id/revoke', async () => {
    stubFetch((c) => {
      if (c.method === 'POST') return jsonResponse({ revoked: true, keys: [{ ...keyRow, revokedAt: '2026-01-03T00:00:00.000Z' }] });
      return jsonResponse({ keys: [keyRow] });
    });
    render(<ApiKeysPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/api-keys/key_1/revoke'));
      expect(post).toBeTruthy();
    });
    expect(await screen.findByText('API key revoked')).toBeInTheDocument();
    expect(screen.getAllByText(/Revoked/).length).toBeGreaterThan(0);
  });

  it('replaces the Developers "Coming soon" entry in the settings dialog', () => {
    store.dispatch(openSettings('General'));
    render(
      <Provider store={store}>
        <SettingsDialog />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Developers' }));
    expect(screen.getByText('API keys')).toBeInTheDocument();
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
  });
});
