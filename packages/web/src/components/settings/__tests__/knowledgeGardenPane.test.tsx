/**
 * Neo N21: the Knowledge Garden pane under Arabic.
 *
 * The pane is the only user-facing view of the garden, so the N21 acceptance
 * criterion "Arabic seed splitting / tokenisation, Arabic search" is only
 * delivered if the pane actually renders the Arabic a base, a seed and a search
 * hit carry. This pins three things with the real component and a stubbed
 * `fetch`:
 *
 *  - every garden string comes from the catalog, so switching to Arabic
 *    replaces the whole pane and never falls back to the English key;
 *  - user content (base name, seed title/body, hit preview) is marked
 *    `dir="auto"`, so an Arabic seed reads right-to-left while an English one
 *    still reads left-to-right in the same list;
 *  - a bilingual search surfaces the Arabic hit and its Arabic tags verbatim.
 *
 * Playwright is not available in this harness, so this is the documented
 * vitest + @testing-library substitute for the "RTL screenshot review".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KnowledgeGardenPane } from '../KnowledgeGardenPane';
import { setLocale } from '@/i18n/t';

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const call: Call = { url, method, body };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch,
  );
}

const BASE_ID = 'kb_ar_1';

/** A base whose own name and seed are Arabic, the shape an Arabic user creates. */
const base = {
  id: BASE_ID,
  name: 'وثائق المنتج',
  description: 'ملاحظات الفوترة والدعم',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  seeds: 2,
};

const seeds = [
  {
    id: 'seed_ar_1',
    title: 'الفوترة',
    body: 'الفوترة تحسب لكل مقعد. تصدر الفاتورة شهريا.',
    tags: ['الفوترة', 'الفريق'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'seed_en_1',
    title: 'Billing',
    body: 'Billing is charged per seat. Invoices are issued monthly.',
    tags: ['billing'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** The default garden: one base, its two seeds, and a bilingual search hit. */
function gardenFetch(call: Call): Response {
  if (call.method === 'GET' && /\/api\/knowledge$/.test(call.url)) {
    return jsonResponse({ bases: [base], enabled: true });
  }
  if (call.method === 'GET' && call.url.includes(`/api/knowledge/${BASE_ID}`)) {
    return jsonResponse({ base, seeds });
  }
  if (call.url.includes('/search')) {
    return jsonResponse({
      query: 'الفوترة',
      mode: 'lexical',
      empty: false,
      hits: [
        {
          seedId: 'seed_ar_1',
          baseId: BASE_ID,
          title: 'الفوترة',
          preview: 'الفوترة تحسب لكل مقعد.',
          tags: ['الفوترة'],
          score: 0.912,
          lexical: 0.912,
          vector: null,
          matched: ['الفوترة'],
        },
      ],
    });
  }
  return jsonResponse({});
}

/** Mount the pane and wait for its first list call to settle. */
async function renderGarden(): Promise<void> {
  render(<KnowledgeGardenPane />);
  // The base name is rendered both as a card title and inside the two base
  // pickers, so wait on the card paragraph rather than on the text alone.
  await waitFor(() => expect(screen.getByText('وثائق المنتج', { selector: 'p' })).toBeInTheDocument());
}

describe('KnowledgeGardenPane Arabic and RTL (N21)', () => {
  beforeEach(() => {
    calls = [];
    setLocale('en');
  });

  afterEach(() => {
    setLocale('en');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders every garden label from the Arabic catalog, with no English fallback', async () => {
    stubFetch(gardenFetch);
    setLocale('ar');
    await renderGarden();

    // Section headings and the controls the N21 pass had to translate.
    expect(screen.getByRole('heading', { name: 'قواعد المعرفة' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'إضافة بذرة' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ابحث في الحديقة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /قاعدة جديدة/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إضافة بذرة/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('تصفية القواعد')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('اسأل الحديقة')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('النص القابل للاسترجاع')).toBeInTheDocument();
    // The count badge uses the Arabic plural, not the English key.
    expect(screen.getByText('1 القواعد')).toBeInTheDocument();

    // None of the raw English keys leak through, which is what a missing key
    // looks like because `t()` falls back to the key itself.
    for (const key of ['Knowledge bases', 'New base', 'Add a seed', 'Search the garden', 'Filter bases']) {
      expect(screen.queryByText(key)).toBeNull();
    }
  });

  it('marks Arabic base and seed content dir="auto" so it reads right-to-left', async () => {
    stubFetch(gardenFetch);
    setLocale('ar');
    await renderGarden();

    // Expand the base to load its seeds.
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(await screen.findByText('الفوترة', { selector: 'p' })).toBeInTheDocument();

    // Every piece of user content is direction-resolved from its own script, so
    // an Arabic name and an English name can share one list.
    expect(screen.getByText('وثائق المنتج', { selector: 'p' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('ملاحظات الفوترة والدعم')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('الفوترة', { selector: 'p' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('الفوترة تحسب لكل مقعد. تصدر الفاتورة شهريا.')).toHaveAttribute('dir', 'auto');
    // The English seed keeps its own direction in the same list.
    expect(screen.getByText('Billing')).toHaveAttribute('dir', 'auto');
  });

  it('keeps the pane on logical CSS so the Arabic layout mirrors without a physical override', async () => {
    stubFetch(gardenFetch);
    setLocale('ar');
    await renderGarden();

    // The filter and search fields are padded with the logical `ps-`/`pe-`
    // utilities, so their icon sits at the start edge (the right) under RTL. A
    // physical `pl-`/`pr-` would keep it on the left and break the mirror.
    for (const placeholder of ['تصفية القواعد', 'اسأل الحديقة']) {
      const field = screen.getByPlaceholderText(placeholder);
      expect(field.className).toContain('ps-8');
      expect(field.className).toContain('pe-3');
      expect(field.className).not.toMatch(/\bpl-|\bpr-/);
    }
  });

  it('searches in Arabic and shows the Arabic hit with its Arabic tags', async () => {
    stubFetch(gardenFetch);
    setLocale('ar');
    await renderGarden();

    fireEvent.change(screen.getByPlaceholderText('اسأل الحديقة'), { target: { value: 'الفوترة' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));

    // The request must actually leave the pane, with the Arabic query intact
    // (the endpoint takes it as a query parameter, not a JSON body).
    await waitFor(() => expect(calls.some((c) => c.url.includes('/search'))).toBe(true));
    const search = calls.find((c) => c.url.includes('/search'));
    // The endpoint takes the query as a parameter, and the Arabic must survive
    // the round trip (fetch re-encodes it, so decode before comparing).
    expect(search?.url).toContain('/api/knowledge/search');
    expect(decodeURIComponent(search?.url ?? '')).toContain('query=الفوترة');

    // The hit renders verbatim, in its own direction.
    const preview = await screen.findByText('الفوترة تحسب لكل مقعد.');
    expect(preview).toHaveAttribute('dir', 'auto');
    // The hit title is a card title, so `الفوترة` is now on the seed and the hit.
    expect(screen.getAllByText('الفوترة').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('الفوترة', { selector: 'span' })).toBeInTheDocument();

    // The Arabic labels for the result header are used.
    expect(screen.getByText(/لفظي فقط/)).toBeInTheDocument();
    expect(screen.getByText(/نتيجة/)).toBeInTheDocument();
  });

  it('shows the Arabic empty and disabled-embedder notices instead of the English keys', async () => {
    stubFetch((call) => {
      if (call.method === 'GET' && /\/api\/knowledge$/.test(call.url)) {
        return jsonResponse({ bases: [], enabled: false });
      }
      return jsonResponse({});
    });
    setLocale('ar');
    render(<KnowledgeGardenPane />);

    expect(await screen.findByText('لا توجد قواعد معرفة بعد.')).toBeInTheDocument();
    // The disabled-embedder notice is the honest signal that search is lexical.
    expect(
      screen.getByText('نموذج التضمين معطّل، لذا يعمل البحث لفظيًا فقط وتُخزَّن البذور الجديدة دون متجهات.'),
    ).toBeInTheDocument();
  });

  it('renders the English catalog unchanged, so the pass did not regress it', async () => {
    stubFetch(gardenFetch);
    setLocale('en');
    render(<KnowledgeGardenPane />);

    expect(await screen.findByRole('heading', { name: 'Knowledge bases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New base/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Filter bases')).toBeInTheDocument();
    // The Arabic values are not used in English.
    expect(screen.queryByText('قواعد المعرفة')).toBeNull();
  });

  it('refuses a seed with no base, using the Arabic message', async () => {
    stubFetch(gardenFetch);
    setLocale('ar');
    await renderGarden();

    // Adding a seed with no base selected must be refused in Arabic, and must
    // not reach the server.
    fireEvent.click(screen.getByRole('button', { name: /إضافة بذرة/ }));
    await waitFor(() => expect(screen.getByText('اختر قاعدة أولًا')).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
