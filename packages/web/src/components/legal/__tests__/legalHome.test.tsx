// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { t } from '@/i18n/t';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://127.0.0.1:3939',
  getApiHeaders: async () => ({ 'x-test': '1' }),
  getLoamAuthHeaders: () => ({ 'x-test': '1' }),
}));

import { LegalHome } from '../LegalHome';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('LegalHome (L1 unified front door)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('lists matters and absorbs the official-sources search', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/legal/matters') && !url.includes('/api/office')) {
        return json({ matters: [{ id: 'm1', title: 'قضية عقد عمل', kind: 'contract_review', asOf: '2026-01-01' }] });
      }
      if (url.includes('/api/legal/status')) return json({ localModelApproved: true, keyAvailable: false });
      if (url.includes('/api/office/legal/sources/search')) {
        return json({ sources: [{ id: 's1', title: 'قانون العمل القطري', citation: 'قانون 14/2004', issuer: 'التشريع', effectiveFrom: '2004', text: 'نص المادة...', sourceUrl: 'https://example.gov.qa' }] });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LegalHome />);
    await waitFor(() => expect(screen.getByText('قضية عقد عمل')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(t('Search Qatari statutes and regulations')), { target: { value: 'عمل' } });
    fireEvent.click(screen.getByRole('button', { name: t('Search') }));
    await waitFor(() => expect(screen.getByText((content) => content.includes('قانون العمل القطري'))).toBeTruthy());
    expect(screen.getByText((content) => content.includes('قانون 14/2004'))).toBeTruthy();
  });
});
