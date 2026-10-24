import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getLoamBase: () => API,
  getLoamAuthHeaders: () => ({ 'x-loam-local-token': 't' }),
}));
vi.mock('@/i18n/t', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/t')>('@/i18n/t');
  return { ...actual, getLocale: () => 'en' };
});

import HelpPage from '../page';

const apiUrl = (path: string) => `${API}/api/docs${path}`;

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (url: string) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const docs = {
  docs: [
    {
      subject: 'canvas',
      file: 'canvas.md',
      title: 'Canvas',
      arabicFile: 'canvas.ar.md',
      arabicTitle: 'اللوحة',
      sections: ['What you are looking at', 'Reading the run'],
      anchors: ['what-you-are-looking-at', 'reading-the-run'],
    },
    {
      subject: 'missions',
      file: 'missions.md',
      title: 'Missions',
      arabicFile: 'missions.ar.md',
      arabicTitle: 'المهمات',
      sections: ['Why a Mission exists'],
      anchors: ['why-a-mission-exists'],
    },
  ],
  missing: [],
};

describe('HelpPage', () => {
  it('lists the guide from GET /api/docs', async () => {
    stubFetch((url) => (url === apiUrl('') ? json(docs) : json({}, 404)));
    render(<HelpPage />);
    expect(await screen.findByText('Canvas')).toBeTruthy();
    expect(screen.getByText('Missions')).toBeTruthy();
  });

  it('opens a page through GET /api/docs/:file', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === apiUrl('')) return json(docs);
      if (url === apiUrl('/canvas.md')) return text('# Canvas\n\nA graph.\n');
      return json({}, 404);
    });
    render(<HelpPage />);
    fireEvent.click(await screen.findByText('Canvas'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(apiUrl('/canvas.md'), expect.anything()),
    );
    expect(await screen.findByText(/A graph/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reading the run' })).toBeTruthy();
  });

  it('links the outline to the anchors the server computed', async () => {
    stubFetch((url) => {
      if (url === apiUrl('')) return json(docs);
      if (url === apiUrl('/canvas.md')) return text('# Canvas\n\nA graph.\n');
      return json({}, 404);
    });
    render(<HelpPage />);
    fireEvent.click(await screen.findByText('Canvas'));

    expect(await screen.findByRole('link', { name: 'Reading the run' })).toHaveAttribute(
      'href',
      '#reading-the-run',
    );
  });

  it('reports the server error instead of rendering an empty page', async () => {
    stubFetch(() => json({ error: 'guide unavailable' }, 500));
    render(<HelpPage />);
    expect(await screen.findByText(/guide unavailable/)).toBeTruthy();
    expect(screen.queryByText('Choose a page on the left.')).not.toBeInTheDocument();
  });

  it('says so when a guide page is missing from the install', async () => {
    stubFetch((url) =>
      url === apiUrl('') ? json({ ...docs, missing: ['canvas.ar.md'] }) : json({}, 404),
    );
    render(<HelpPage />);
    expect(await screen.findByText(/canvas\.ar\.md/)).toBeTruthy();
  });
});
