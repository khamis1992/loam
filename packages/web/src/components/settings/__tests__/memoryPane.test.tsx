import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({ 'x-test': '1' }),
}));

import { MemoryPane } from '../MemoryPane';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let handler: (url: string) => Response = () => json({});

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

describe('MemoryPane', () => {
  beforeEach(() => {
    handler = () => json({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the memory status and entries', async () => {
    stubFetch();
    handler = (url) => {
      if (url.includes('/api/memory/status')) {
        return json({ enabled: true, count: 2, model: 'text-embedding-3' });
      }
      if (url.includes('/api/memory')) {
        return json({
          entries: [
            { id: 'e1', text: 'Prefers concise answers', kind: 'preference', tags: ['tone', 'style'] },
          ],
        });
      }
      return json({});
    };
    render(<MemoryPane />);

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('text-embedding-3')).toBeInTheDocument();
    expect(screen.getByText('Prefers concise answers')).toBeInTheDocument();
    expect(screen.getByText('tone')).toBeInTheDocument();
  });

  it('shows Disabled and a zero count when memory is off', async () => {
    stubFetch();
    handler = (url) => {
      if (url.includes('/api/memory/status')) return json({ enabled: false, count: 0 });
      return json({ entries: [] });
    };
    render(<MemoryPane />);

    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('shows the empty state when there are no entries', async () => {
    stubFetch();
    handler = (url) => {
      if (url.includes('/api/memory/status')) return json({ enabled: true, count: 0 });
      return json({ entries: [] });
    };
    render(<MemoryPane />);

    expect(await screen.findByText('No memory entries.')).toBeInTheDocument();
  });

  it('shows the load error without crashing when the store is unreachable', async () => {
    stubFetch();
    handler = () => json({ error: 'status 500' }, 500);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<MemoryPane />);

    expect(await screen.findByText(/Failed to load memory/)).toBeInTheDocument();
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
  });
});
