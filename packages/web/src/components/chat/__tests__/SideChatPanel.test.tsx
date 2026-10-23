import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import { SideChatPanel } from '../SideChatPanel';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SideChatPanel', () => {
  it('sends a read-only side-chat question to the btw route', async () => {
    const fetchMock = vi.fn(async () =>
      json({ taskId: 'side-1', sideChat: true, readOnlyTools: ['file_read'] }, 202),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SideChatPanel taskId="main-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Ask a side question/ }));

    const input = screen.getByLabelText('Side question');
    fireEvent.change(input, { target: { value: 'what changed in src/index.ts?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${API}/api/tasks/main-1/btw`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ question: 'what changed in src/index.ts?' }),
        }),
      ),
    );

    expect(await screen.findByText('what changed in src/index.ts?')).toBeTruthy();
    expect(screen.getByText('read-only')).toBeTruthy();
  });

  it('surfaces a server error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'run engine is not ready' }, 503)));

    render(<SideChatPanel taskId="main-2" />);
    fireEvent.click(screen.getByRole('button', { name: /Ask a side question/ }));
    fireEvent.change(screen.getByLabelText('Side question'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('run engine is not ready')).toBeTruthy();
  });

  it('disables sending without a task id', () => {
    render(<SideChatPanel taskId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask a side question/ }));
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
