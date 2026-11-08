// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t } from '@/i18n/t';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://127.0.0.1:3939', getApiHeaders: async () => ({ 'x-test': '1' }), getLoamBase: () => 'http://127.0.0.1:3939',
}));
vi.mock('../EvidenceBoard', () => ({ EvidenceBoard: () => <div /> }));
vi.mock('../ContractReview', () => ({ ContractReview: () => <div /> }));
vi.mock('../DefenseStrategy', () => ({ DefenseStrategy: () => <div /> }));
vi.mock('../ResponseMatrix', () => ({ ResponseMatrix: () => <div /> }));
vi.mock('../DocumentAnalysisView', () => ({ DocumentAnalysisView: () => <div /> }));
vi.mock('../DocumentViewer', () => ({ DocumentViewer: () => <div /> }));
vi.mock('../PrivacyBadge', () => ({ PrivacyBadge: () => <div /> }));
vi.mock('../LegalRunControls', () => ({ LegalRunControls: () => <div /> }));

import { LegalWorkspace } from '../LegalWorkspace';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('LegalWorkspace navigation', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('provides a way back and keyboard-accessible review tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/documents')) return json({ documents: [], facts: [], timeline: [], contradictions: [] });
      if (url.includes('/status')) return json({ localModelApproved: true, keyAvailable: true });
      return json({ matter: { id: 'm1', title: 'قضية', kind: 'defense_memo', asOf: '2026-01-01', parties: [] }, reviews: [] });
    }));
    render(<LegalWorkspace matterId="m1" />);
    await waitFor(() => expect(screen.getByText('قضية')).toBeTruthy());
    expect(screen.getByRole('link', { name: t('Back to Legal Qatar') }).getAttribute('href')).toBe('/legal');
    const reviews = screen.getByRole('tab', { name: t('reviews') });
    fireEvent.keyDown(reviews, { key: 'Home' });
    fireEvent.keyDown(reviews, { key: 'End' });
    expect(reviews.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText(t('Review work queue'))).toBeTruthy();
  });
});
