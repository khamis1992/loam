// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { t } from '@/i18n/t';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://127.0.0.1:3939',
  getApiHeaders: async () => ({ 'x-test': '1' }),
  getLoamAuthHeaders: () => ({ 'x-test': '1' }),
}));

// L1 merged with PR-3: /legal renders the shared <LibrarySearch /> (the
// weekly-synced Qatar library with verify-before-cite) instead of an inline
// search — assert the integration, not the library's own internals.
vi.mock('../LibrarySearch', () => ({
  LibrarySearch: () => <div data-testid="library-search">library</div>,
}));
vi.mock('../CorpusAdmin', () => ({
  CorpusAdmin: () => <div data-testid="corpus-admin">sources</div>,
}));
vi.mock('../LegalOperations', () => ({
  LegalOperations: () => <div data-testid="legal-operations">operations</div>,
}));

import { LegalHome } from '../LegalHome';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('LegalHome (L1 unified front door)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('lists matters and mounts the Qatar library search', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/legal/matters')) {
        return json({ matters: [{ id: 'm1', title: 'قضية عقد عمل', kind: 'contract_review', asOf: '2026-01-01' }] });
      }
      if (url.includes('/api/legal/status')) return json({ localModelApproved: true, keyAvailable: false });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LegalHome />);
    await waitFor(() => expect(screen.getByText('قضية عقد عمل')).toBeTruthy());
    expect(screen.getByTestId('library-search')).toBeTruthy();
    expect(screen.getByTestId('corpus-admin')).toBeTruthy();
    expect(screen.getByRole('link', { name: t('Back') }).getAttribute('href')).toBe('/');
  });
});
