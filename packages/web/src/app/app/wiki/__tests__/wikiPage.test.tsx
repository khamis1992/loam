import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import WikiPage from '../page';

const apiUrl = (path: string) => `${API}/api${path}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wikis = {
  wikis: [
    {
      project: 'fixture-wiki',
      generatedAt: '2026-01-01T00:00:00.000Z',
      pages: [
        { title: 'Overview', slug: 'overview', parent: undefined },
        { title: 'Architecture', slug: 'architecture', parent: undefined },
      ],
    },
  ],
};

describe('WikiPage', () => {
  it('lists wiki projects and their pages from GET /api/wiki', async () => {
    stubFetch((url) => {
      if (url === apiUrl('/wiki')) return json(wikis);
      if (url === apiUrl('/wiki/fixture-wiki')) {
        return json({ project: 'fixture-wiki', pages: wikis.wikis[0]!.pages });
      }
      return json({}, 404);
    });
    render(<WikiPage />);
    expect(await screen.findByText('fixture-wiki')).toBeTruthy();
    // The page auto-selects the first project, so the page title can legitimately
    // appear in BOTH the sidebar list and the main column (racy single-match
    // getByText flaked here) — assert at least one of each instead.
    expect((await screen.findAllByText('Overview')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Architecture').length).toBeGreaterThanOrEqual(1);
  });

  it('opens a page through GET /api/wiki/:project/:slug', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === apiUrl('/wiki')) return json(wikis);
      if (url === apiUrl('/wiki/fixture-wiki')) {
        return json({ project: 'fixture-wiki', pages: wikis.wikis[0]!.pages });
      }
      if (url === apiUrl('/wiki/fixture-wiki/overview')) {
        return json({ page: { title: 'Overview', content: '# Overview\n\nHello wiki.' } });
      }
      return json({}, 404);
    });
    render(<WikiPage />);
    fireEvent.click(await screen.findByText('Overview'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(apiUrl('/wiki/fixture-wiki/overview'), expect.anything()),
    );
    expect(await screen.findByText(/Hello wiki/)).toBeTruthy();
  });
});
