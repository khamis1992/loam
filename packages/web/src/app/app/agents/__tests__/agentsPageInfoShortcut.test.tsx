import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const API = 'http://localhost:8787';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('agent=a1'),
}));

vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import AgentsPageClient from '../AgentsPageClient';
import { StoreProvider } from '@/store';

const agent = { id: 'a1', name: 'Ada', emoji: '🤖', description: 'Builds things', mode: 'build' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/agents')) return json({ agents: [agent] });
    if (url.endsWith('/api/groups')) return json({ groups: [] });
    if (url.endsWith('/api/agent-threads')) return json({ threads: [] });
    return json({});
  }));
}

const overviewHeading = () => screen.queryByRole('heading', { level: 2, name: 'Overview' });

describe('AgentsPageClient info pane keyboard toggle (Cmd/Ctrl+Shift+I)', () => {
  beforeEach(() => {
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('toggles the info pane open and closed with Ctrl+Shift+I', async () => {
    render(<StoreProvider><AgentsPageClient /></StoreProvider>);
    await screen.findAllByText('Ada');
    expect(overviewHeading()).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(overviewHeading()).not.toBeInTheDocument());
  });

  it('toggles the info pane with Cmd+Shift+I on macOS', async () => {
    render(<StoreProvider><AgentsPageClient /></StoreProvider>);
    await screen.findAllByText('Ada');
    fireEvent.keyDown(window, { key: 'i', metaKey: true, shiftKey: true });
    expect(await screen.findByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
  });

  it('ignores Shift+I without Cmd/Ctrl', async () => {
    render(<StoreProvider><AgentsPageClient /></StoreProvider>);
    await screen.findAllByText('Ada');
    fireEvent.keyDown(window, { key: 'i', shiftKey: true });
    expect(overviewHeading()).not.toBeInTheDocument();
  });
});
