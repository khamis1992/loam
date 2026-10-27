import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalView, type ClientPortalView } from '../PortalView';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/portal/abc123'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('@/services/rpc', () => ({
  getApiBase: () => '',
  getLoamBase: () => 'http://127.0.0.1:3939',
  getLoamAuthHeaders: () => ({}),
}));

const view: ClientPortalView = {
  title: 'قضية التحكيم التجاري',
  client: 'شركة الأمل',
  status: 'active',
  summary: 'ملخص سير القضية للمورد.',
  updatedAt: '2026-02-01T00:00:00.000Z',
  deadlines: [
    { id: 'd1', title: 'تقديم المذكرات', dueAt: '2026-03-01T00:00:00.000Z', status: 'upcoming', owner: 'أ. خالد' },
    { id: 'd2', title: 'جلسة الخبراء', dueAt: '2026-04-01T00:00:00.000Z', status: 'upcoming' },
  ],
  artifacts: ['عقد-التحكيم.pdf', 'المذكرة-الأولى.docx'],
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function notFoundResponse(): Response {
  return { ok: false, status: 404, json: async () => ({ error: 'portal share is expired or revoked' }) } as unknown as Response;
}

describe('PortalView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the matter read-only in Arabic RTL with counters, deadlines and artifacts', async () => {
    const fetchMock = vi.fn(async () => okResponse({ portal: view }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PortalView />);

    expect(await screen.findByText('قضية التحكيم التجاري')).toBeInTheDocument();
    // The whole page is RTL Arabic.
    expect(screen.getByRole('main')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByText('بوابة العميل القانونية')).toBeInTheDocument();
    expect(screen.getByText(/شركة الأمل/)).toBeInTheDocument();
    expect(screen.getByText('نشطة')).toBeInTheDocument();
    expect(screen.getByText(/ملخص سير القضية للمورد./)).toBeInTheDocument();
    expect(screen.getByText('تقديم المذكرات')).toBeInTheDocument();
    expect(screen.getByText(/أ. خالد/)).toBeInTheDocument();
    expect(screen.getByText('جلسة الخبراء')).toBeInTheDocument();
    expect(screen.getByText('عقد-التحكيم.pdf')).toBeInTheDocument();
    expect(screen.getByText('المذكرة-الأولى.docx')).toBeInTheDocument();
    expect(screen.getByTestId('portal-counter-deadlines')).toHaveTextContent('مواعيد قادمة: 2');
    expect(screen.getByTestId('portal-counter-artifacts')).toHaveTextContent('مستندات ومرفقات: 2');
    // Read-only: the token feed carries no write affordances.
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/office/portal/abc123');
  });

  it('shows a clear Arabic message for expired, revoked or unknown tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()));
    render(<PortalView />);
    expect(await screen.findByText(/هذا الرابط غير صالح أو منتهي الصلاحية أو ملغى./)).toBeInTheDocument();
    expect(screen.getByText(/تواصل مع فريقك القانوني/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('قضية التحكيم التجاري')).toBeNull());
  });

  it('marks a missing token as invalid without calling the API', async () => {
    vi.mocked(await import('next/navigation')).usePathname.mockReturnValue('/portal');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<PortalView />);
    expect(await screen.findByText(/هذا الرابط غير صالح أو منتهي الصلاحية أو ملغى./)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
