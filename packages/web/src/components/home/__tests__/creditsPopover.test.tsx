import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '@/store';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('@/services/rpc', () => ({ getApiBase: () => API }));

import { CreditsPopover } from '../CreditsPopover';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('CreditsPopover', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the plan from GET /api/credits when opened', async () => {
    const fetchMock = vi.fn(async () =>
      json({ balance: 750, plan: 'pro', ledger: [], referral: { code: 'R', link: 'l', bonus: 500 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <Provider store={store}>
        <CreditsPopover total={750} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /750/ }));
    expect(await screen.findByText(/Pro plan/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/credits`, undefined);
  });

  it('renders the free plan label when the store reports free', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ balance: 100, plan: 'free', ledger: [], referral: { code: 'R', link: 'l', bonus: 500 } })));
    render(
      <Provider store={store}>
        <CreditsPopover total={100} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /100/ }));
    expect(await screen.findByText(/Free plan/)).toBeTruthy();
  });
});
