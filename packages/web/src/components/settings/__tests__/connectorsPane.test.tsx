import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('@/services/rpc', () => ({ getApiBase: () => API, getApiHeaders: async () => ({}) }));

import { ConnectorsPane } from '../ConnectorsPane';

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

describe('ConnectorsPane', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders connector state: connected, not configured and disconnected', async () => {
    stubFetch((url) => {
      if (url === apiUrl('/connectors')) {
        return json({
          connectors: [
            { id: 'github', name: 'GitHub', configured: true, connected: true, account: 'octocat', envVars: [] },
            { id: 'gmail', name: 'Gmail', configured: false, connected: false, account: null, envVars: ['GMAIL_CLIENT_ID'] },
            { id: 'calendar', name: 'Calendar', configured: true, connected: false, account: null, envVars: [] },
          ],
        });
      }
      if (url === apiUrl('/mcp/status')) return json({ servers: [] });
      return json({}, 404);
    });
    render(<ConnectorsPane />);
    expect(await screen.findByText('GitHub')).toBeTruthy();
    expect(screen.getByText(/Connected as octocat/)).toBeTruthy();
    expect(screen.getAllByText(/Not configured/).length).toBeGreaterThan(0);
    expect(screen.getByText(/GMAIL_CLIENT_ID/)).toBeTruthy();
    // Only configured connectors expose an action button.
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('connects an OAuth connector by opening the provider auth URL', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    stubFetch((url) => {
      if (url === apiUrl('/connectors')) {
        return json({ connectors: [{ id: 'calendar', name: 'Calendar', configured: true, connected: false, account: null, envVars: [] }] });
      }
      if (url === apiUrl('/connectors/calendar/connect')) return json({ authUrl: 'https://calendar.example/auth' });
      if (url === apiUrl('/mcp/status')) return json({ servers: [] });
      return json({}, 404);
    });
    render(<ConnectorsPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://calendar.example/auth', '_blank', 'noopener'));
  });

  it('disconnects a connected connector', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/connectors')) {
        return json({ connectors: [{ id: 'github', name: 'GitHub', configured: true, connected: true, account: 'octocat', envVars: [] }] });
      }
      if (url === apiUrl('/connectors/github/disconnect') && init?.method === 'POST') return json({ ok: true });
      if (url === apiUrl('/mcp/status')) return json({ servers: [] });
      return json({}, 404);
    });
    render(<ConnectorsPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(apiUrl('/connectors/github/disconnect'), expect.objectContaining({ method: 'POST' })),
    );
  });

  it('shows a load error when the connectors store is unreachable', async () => {
    stubFetch((url) => {
      if (url === apiUrl('/mcp/status')) return json({ servers: [] });
      return json({ error: 'nope' }, 500);
    });
    render(<ConnectorsPane />);
    expect(await screen.findByText(/nope/)).toBeTruthy();
  });
});
