import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import { MemoryHub } from '../MemoryHub';

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

/** Every endpoint the four settings panes touch gets a minimal valid reply. */
const defaultHandler: Handler = (url) => {
  const u = url.split('?')[0]!;
  if (u === apiUrl('/memory/status')) return json({ enabled: true, count: 2 });
  if (u === apiUrl('/memory')) return json({ entries: [{ id: 'm1', text: 'User prefers dark mode.' }, { id: 'm2', text: 'Ships on Fridays.' }] });
  if (u === apiUrl('/knowledge/bases')) return json({ bases: [] });
  if (u === apiUrl('/learning/lessons')) {
    return json({
      data: [{
        id: 'l1', agentId: null, domain: 'build', source: 'correction',
        cue: 'When bumping deps', lesson: 'Always pin dependency versions.',
        evidence: 'The user corrected the agent twice.', confidence: 'high',
        sourceRef: '', uses: 3, createdAt: '2026-01-01T00:00:00.000Z',
      }],
    });
  }
  if (u === apiUrl('/project-wiki/status')) return json({ enabled: true });
  if (u === apiUrl('/project-wiki/pages')) return json({ pages: [] });
  if (u === apiUrl('/handoffs')) return json({ handoffs: [] });
  return json({});
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MemoryHub', () => {
  it('renders the four tabs with memories as the default tab', () => {
    stubFetch(defaultHandler);
    render(<MemoryHub />);

    expect(screen.getByTestId('memory-tab-memories').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('memory-tab-garden')).toBeTruthy();
    expect(screen.getByTestId('memory-tab-lessons')).toBeTruthy();
    expect(screen.getByTestId('memory-tab-wiki')).toBeTruthy();
    expect(screen.getByTestId('memory-panel-memories')).toBeTruthy();
  });

  it('mounts the MemoryPane content (memories list from GET /api/memory)', async () => {
    stubFetch(defaultHandler);
    render(<MemoryHub />);

    await waitFor(() => expect(screen.getByTestId('memory-panel-memories').textContent).toContain('User prefers dark mode.'));
  });

  it('mounts the Knowledge Garden pane when its tab is selected', async () => {
    stubFetch(defaultHandler);
    render(<MemoryHub />);

    fireEvent.click(screen.getByTestId('memory-tab-garden'));
    await waitFor(() => expect(screen.getByTestId('memory-panel-garden')).toBeTruthy());
    // The garden pane fetches its bases from the same knowledge API.
    await waitFor(() => expect(screen.getByTestId('memory-panel-garden').textContent.length).toBeGreaterThan(0));
  });

  it('mounts the Lessons pane with lessons from GET /api/learning/lessons', async () => {
    stubFetch(defaultHandler);
    render(<MemoryHub />);

    fireEvent.click(screen.getByTestId('memory-tab-lessons'));
    await waitFor(() => expect(screen.getByTestId('memory-panel-lessons').textContent).toContain('Always pin dependency versions.'));
  });

  it('mounts the Wiki pane when its tab is selected', async () => {
    stubFetch(defaultHandler);
    render(<MemoryHub />);

    fireEvent.click(screen.getByTestId('memory-tab-wiki'));
    await waitFor(() => expect(screen.getByTestId('memory-panel-wiki')).toBeTruthy());
    // WikiSection hit /project-wiki/status for its enabled state.
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.startsWith(apiUrl('/project-wiki/status')))).toBe(true);
    });
  });
});
