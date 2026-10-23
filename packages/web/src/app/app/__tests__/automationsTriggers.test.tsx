import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import AutomationsPage from '../automations/page';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AutomationsPage event triggers', () => {
  it('renders the list with webhook and github trigger labels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({
        schedules: [
          { id: 's1', prompt: 'Deploy finished', intervalSeconds: 3600, enabled: true, trigger: 'webhook' },
          {
            id: 's2',
            prompt: 'Review PR',
            intervalSeconds: 3600,
            enabled: true,
            trigger: 'github',
            githubEvents: ['issue_comment.created'],
          },
          { id: 's3', prompt: 'Nightly digest', intervalSeconds: 3600, enabled: true, cron: '0 9 * * *' },
        ],
      }),
    ));

    render(<AutomationsPage />);

    expect(await screen.findByText('Deploy finished')).toBeTruthy();
    expect(screen.getByText('Review PR')).toBeTruthy();
    expect(screen.getByText('Nightly digest')).toBeTruthy();
    // Trigger labels are shown alongside the schedule cadence.
    expect(screen.getAllByText(/Webhook/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GitHub/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Schedule/).length).toBeGreaterThan(0);
  });
});
