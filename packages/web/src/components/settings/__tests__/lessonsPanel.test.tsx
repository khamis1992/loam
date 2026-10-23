import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({ 'x-test': '1' }),
}));

import { LessonsPanel } from '../LessonsPanel';
import { setLocale } from '@/i18n/t';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface LessonRow {
  id: string;
  agentId: string | null;
  domain: string;
  source: 'correction' | 'critic' | 'selfplay';
  cue: string;
  lesson: string;
  evidence: string;
  confidence: 'low' | 'medium' | 'high';
  sourceRef: string;
  uses: number;
  createdAt: string;
}

const LESSONS: LessonRow[] = [
  {
    id: 'les_aaa',
    agentId: null,
    domain: 'nutrio-content',
    source: 'correction',
    cue: 'when writing Arabic content about the app',
    lesson: 'Write the name «نتريو» in Arabic, not Nutrio.',
    evidence: 'the user corrected the spelling of the name',
    confidence: 'high',
    sourceRef: 'cor_1',
    uses: 3,
    createdAt: '2026-10-20T12:00:00.000Z',
  },
  {
    id: 'les_bbb',
    agentId: null,
    domain: 'general',
    source: 'critic',
    cue: 'when a task needs a file write',
    lesson: 'Confirm the path before writing.',
    evidence: 'a failed case wrote to the wrong folder',
    confidence: 'low',
    sourceRef: 'cor_2',
    uses: 0,
    createdAt: '2026-10-21T12:00:00.000Z',
  },
];

type Handler = (url: string, init?: RequestInit) => Response;

let handler: Handler = () => json({});

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch,
  );
}

/** Let the panel settle after it has loaded its rows. */
async function renderPanel() {
  const view = render(<LessonsPanel />);
  await waitFor(() => expect(screen.queryByText('Loading')).not.toBeInTheDocument());
  return view;
}

describe('LessonsPanel', () => {
  beforeEach(() => {
    setLocale('en');
    handler = () => json({});
  });
  afterEach(() => {
    setLocale('en');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the list of lessons with cue, evidence, uses and confidence', async () => {
    stubFetch();
    handler = (url) => {
      if (url.includes('/api/learning/lessons')) return json({ data: LESSONS });
      return json({ lessonsAutoApply: true });
    };
    await renderPanel();

    expect(screen.getByText('Write the name «نتريو» in Arabic, not Nutrio.')).toBeInTheDocument();
    expect(screen.getByText('when writing Arabic content about the app')).toBeInTheDocument();
    expect(screen.getByText('the user corrected the spelling of the name')).toBeInTheDocument();
    // Uses + confidence come from the row metadata, not the body text.
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Confidence:').length).toBe(2);
    expect(screen.getAllByText('Domain:').length).toBe(2);
    expect(screen.getByText('nutrio-content')).toBeInTheDocument();
    expect(screen.getAllByText('Delete').length).toBe(2);
  });

  it('sends a DELETE for the row and removes it from the list', async () => {
    stubFetch();
    handler = (url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.includes('/api/learning/lessons')) return json({ data: LESSONS });
      return json({ lessonsAutoApply: true });
    };
    await renderPanel();

    expect(screen.getAllByTestId('lesson-row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Delete: Write the name/ }));

    await waitFor(() => expect(screen.getAllByTestId('lesson-row')).toHaveLength(1));
    expect(screen.queryByText('Write the name «نتريو» in Arabic, not Nutrio.')).not.toBeInTheDocument();
    expect(screen.getByText('Confirm the path before writing.')).toBeInTheDocument();
  });

  it('keeps the row and shows the error when the delete is refused', async () => {
    stubFetch();
    handler = (url, init) => {
      if (init?.method === 'DELETE') return json({ error: 'no lesson les_aaa' }, 404);
      if (url.includes('/api/learning/lessons')) return json({ data: LESSONS });
      return json({ lessonsAutoApply: true });
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Delete: Write the name/ }));

    expect(await screen.findByText('no lesson les_aaa')).toBeInTheDocument();
    expect(screen.getAllByTestId('lesson-row')).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it('shows the empty state when there are no lessons', async () => {
    stubFetch();
    handler = (url) => {
      if (url.includes('/api/learning/lessons')) return json({ data: [] });
      return json({ lessonsAutoApply: true });
    };
    await renderPanel();

    expect(screen.getByText('No lessons yet.')).toBeInTheDocument();
    expect(screen.queryAllByTestId('lesson-row')).toHaveLength(0);
  });

  it('reports the load failure instead of crashing', async () => {
    stubFetch();
    handler = () => json({ error: 'status 500' }, 500);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<LessonsPanel />);

    expect(await screen.findByText(/Failed to load lessons/)).toBeInTheDocument();
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    errorSpy.mockRestore();
  });

  it('renders Arabic labels without any untranslated placeholder', async () => {
    setLocale('ar');
    stubFetch();
    handler = (url) => {
      if (url.includes('/api/learning/lessons')) return json({ data: LESSONS });
      return json({ lessonsAutoApply: true });
    };
    await renderPanel();

    expect(screen.getAllByText('درجة الثقة:').length).toBe(2);
    expect(screen.getAllByText('مرات الاستخدام:').length).toBe(2);
    expect(screen.getAllByText('حذف').length).toBe(2);
    // The Arabic source label is rendered, not left as the raw enum value.
    expect(screen.getByText('تصحيح المستخدم')).toBeInTheDocument();
    expect(screen.queryByText('correction')).not.toBeInTheDocument();
  });
});
