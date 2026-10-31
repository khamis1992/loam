// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { t } from '@/i18n/t';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://127.0.0.1:3939',
  getApiHeaders: async () => ({ 'x-test': '1' }),
  getLoamAuthHeaders: () => ({ 'x-test': '1' }),
}));

import FinancePanel from '../FinancePanel';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('FinancePanel (blueprint §7.5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('computes DCF and shows the enterprise value', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/finance/dcf')) {
        return json({ result: {
          discountedFlows: [{ year: 1, flow: 1000, presentValue: 909.09 }],
          terminalValue: 14025, terminalPresentValue: 11590.9,
          enterpriseValue: 13409.08, equityValue: 13409.08,
        } });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FinancePanel />);
    const computeButtons = screen.getAllByRole('button', { name: t('Compute') });
    fireEvent.click(computeButtons[0]!);
    await waitFor(() => expect(screen.getByTestId('dcf-result')).toBeTruthy());
    expect(screen.getByTestId('dcf-result').textContent).toContain('13,409');
  });

  it('runs the audit and renders findings', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/finance/audit')) {
        return json({ result: { findings: [
          { severity: 'high', code: 'duplicate-payment', message: 'دفعتان متطابقتان', entryIds: ['p1', 'p2'] },
        ] } });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FinancePanel />);
    fireEvent.click(screen.getByRole('button', { name: t('Run audit') }));
    await waitFor(() => expect(screen.getByTestId('audit-findings')).toBeTruthy());
    expect(screen.getByTestId('audit-findings').textContent).toContain('دفعتان متطابقتان');
  });
});
