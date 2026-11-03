import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import MarketplacePageClient from '@/app/app/marketplace/MarketplacePageClient';
import { SkillsMarket, skillShortName } from '../SkillsMarket';

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

const catalogEntry = {
  id: 'bd-test-bot',
  source: ['botdirectory'],
  name: 'Test Bot',
  description: 'Does useful work on a schedule',
  category: 'Operations',
  tags: ['Operations'],
  icon: '',
  iconStyle: { monogram: 'T', categoryColor: 'Operations' },
  instructions: 'Handle the work.',
  tools: ['Notion'],
  skills: [],
  memories: [],
  routines: [],
  author: { name: 'benln' },
  sourceUrl: 'https://botdirectory.ai/bots/test-bot/',
  license: 'MIT',
};

const catalogSkills = {
  source: 'aitmpl',
  total: 2,
  shown: 2,
  skills: [
    { id: 'web/scrape-site', files: 3, description: 'Scrape any site into markdown.' },
    { id: 'pdf/merge-pdfs', files: 1, description: 'Merge PDF documents.' },
  ],
};

describe('SkillsMarket (marketplace skills tab)', () => {
  it('renders the catalog grid from GET /api/skills/catalog and marks installed skills', async () => {
    stubFetch((url) => {
      if (url === apiUrl('/skills')) return json({ skills: [{ name: 'merge-pdfs', description: '' }] });
      if (url.startsWith(apiUrl('/skills/catalog'))) return json(catalogSkills);
      return json({}, 404);
    });
    render(<SkillsMarket />);

    await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(2));
    expect(screen.getByText('scrape-site')).toBeTruthy();
    expect(screen.getByText('pdf/merge-pdfs')).toBeTruthy();
    // Installed state: the pdf skill is installed (its short name matches GET /api/skills).
    expect(screen.getByText('Installed')).toBeTruthy();
    expect(screen.getByText('web/scrape-site')).toBeTruthy();
  });

  it('calls POST /api/skills/install with the catalog id and flips the button state', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === apiUrl('/skills')) return json({ skills: [] });
      if (url.startsWith(apiUrl('/skills/catalog'))) return json(catalogSkills);
      return json({}, 404);
    });
    render(<SkillsMarket />);

    await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(2));
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === apiUrl('/skills/install')) return json({ id: 'web/scrape-site', name: 'scrape-site', files: ['a'] });
      return json({}, 404);
    });

    fireEvent.click(screen.getAllByTestId('skill-install')[0]!);

    await waitFor(() => expect(screen.getByText('Installed')).toBeTruthy());
    const installCall = fetchMock.mock.calls.find(([u]) => String(u) === apiUrl('/skills/install'));
    expect(installCall).toBeTruthy();
    expect((installCall?.[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((installCall?.[1] as RequestInit).body))).toEqual({ id: 'web/scrape-site' });
  });

  it('shows an error row when the catalog endpoint fails', async () => {
    stubFetch((url) => {
      if (url === apiUrl('/skills')) return json({ skills: [] });
      if (url.startsWith(apiUrl('/skills/catalog'))) return json({ error: 'registry unreachable' }, 502);
      return json({}, 404);
    });
    render(<SkillsMarket />);
    await waitFor(() => expect(screen.getByTestId('skills-error')).toBeTruthy());
    expect(screen.getByTestId('skills-error').textContent).toContain('registry unreachable');
  });

  it('derives short names from catalog ids', () => {
    expect(skillShortName('pdf/merge-pdfs')).toBe('merge-pdfs');
    expect(skillShortName('plain-name')).toBe('plain-name');
  });
});

describe('MarketplacePageClient tab strip', () => {
  it('renders the three tabs and keeps the bots directory as the first (default) tab', async () => {
    stubFetch((url) => {
      if (url.endsWith('/marketplace/catalog.json')) return json([catalogEntry]);
      if (url === apiUrl('/marketplace/installs')) return json({ installs: [] });
      if (url === apiUrl('/skills')) return json({ skills: [] });
      if (url.startsWith(apiUrl('/skills/catalog'))) return json(catalogSkills);
      return json({}, 404);
    });
    render(<MarketplacePageClient />);

    expect(screen.getByTestId('market-tab-bots').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('market-tab-skills').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('market-tab-bridges').getAttribute('aria-selected')).toBe('false');
    // Default tab content is the bots directory (table and card views both
    // render in jsdom, so the name can legitimately appear more than once).
    await waitFor(() => expect(screen.getAllByText('Test Bot').length).toBeGreaterThan(0));
  });

  it('mounts the skills grid when the skills tab is selected and swaps the panels', async () => {
    stubFetch((url) => {
      if (url.endsWith('/marketplace/catalog.json')) return json([catalogEntry]);
      if (url === apiUrl('/marketplace/installs')) return json({ installs: [] });
      if (url === apiUrl('/skills')) return json({ skills: [] });
      if (url.startsWith(apiUrl('/skills/catalog'))) return json(catalogSkills);
      return json({}, 404);
    });
    render(<MarketplacePageClient />);

    await waitFor(() => expect(screen.getAllByText('Test Bot').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('market-tab-skills'));

    await waitFor(() => expect(screen.getByTestId('skills-grid')).toBeTruthy());
    expect(screen.getByTestId('market-tab-skills').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryAllByText('Test Bot')).toHaveLength(0);
  });
});
