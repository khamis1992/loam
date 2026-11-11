import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import AutomationsPage from '../page';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(schedule: { id: string; prompt: string }) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${API}/api/schedules` && init?.method === 'POST') return json({ schedule });
    return json({ schedules: [] });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function postBody(mock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const call = mock.mock.calls.find(([url, init]) => String(url) === `${API}/api/schedules` && init?.method === 'POST');
  expect(call).toBeTruthy();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

async function openCreation(kind: 'Trigger' | 'Advanced automation') {
  render(<AutomationsPage />);
  await screen.findByText('No automation updates yet.');
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  fireEvent.click(screen.getByRole('menuitem', { name: kind === 'Trigger' ? 'Trigger' : /Advanced automation/ }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AutomationsPage trigger creation', () => {
  it('creates a signed webhook and shows its one-time setup values', async () => {
    const fetchMock = stubFetch({ id: 'sched_webhook', prompt: 'Process new order' });
    await openCreation('Trigger');
    fireEvent.change(screen.getByTestId('automation-brief'), { target: { value: 'Process new order' } });
    fireEvent.click(screen.getByTestId('automation-kind-triggered'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${API}/api/schedules`, expect.objectContaining({ method: 'POST' })));
    const body = postBody(fetchMock);
    expect(body.prompt).toBe('Process new order');
    expect(body.trigger).toBe('webhook');
    expect(String(body.webhookSecret)).toHaveLength(32);

    expect(await screen.findByText('Webhook setup')).toBeTruthy();
    expect(screen.getByText(`${API}/api/automations/trigger/sched_webhook`)).toBeTruthy();
    expect(screen.getByText(String(body.webhookSecret))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy webhook URL' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy secret' })).toBeTruthy();
  });

  it('creates a GitHub event trigger with the selected event allowlist', async () => {
    const fetchMock = stubFetch({ id: 'sched_github', prompt: 'Review new issues' });
    await openCreation('Trigger');
    fireEvent.change(screen.getByTestId('automation-brief'), { target: { value: 'Review new issues' } });
    fireEvent.click(screen.getByTestId('automation-kind-triggered'));
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    fireEvent.change(screen.getByPlaceholderText('pull_request.opened, issues.opened'), { target: { value: 'issues.opened, pull_request.opened' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${API}/api/schedules`, expect.objectContaining({ method: 'POST' })));
    const body = postBody(fetchMock);
    expect(body.trigger).toBe('github');
    expect(body.githubEvents).toEqual(['issues.opened', 'pull_request.opened']);
    expect(String(body.webhookSecret)).toHaveLength(32);
  });

  it('creates an advanced automation with a natural-language playbook and check interval', async () => {
    const fetchMock = stubFetch({ id: 'sched_advanced', prompt: 'When a report arrives, summarize it' });
    await openCreation('Advanced automation');
    fireEvent.change(screen.getByTestId('automation-brief'), { target: { value: 'When a report arrives, summarize it' } });
    fireEvent.click(screen.getByTestId('automation-kind-advanced'));
    fireEvent.change(screen.getByLabelText('Check interval in seconds'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${API}/api/schedules`, expect.objectContaining({ method: 'POST' })));
    const body = postBody(fetchMock);
    expect(body.intervalSeconds).toBe(900);
    expect(body.playbook).toBe('When a report arrives, summarize it');
    expect(body.trigger).toBeUndefined();
  });

  it('shows real run updates and the matching automation in Manage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      schedules: [{
        id: 'sched_runs',
        prompt: 'Monthly reconciliation',
        intervalSeconds: 3600,
        enabled: false,
        lastRunAt: '2026-08-01T08:03:00.000Z',
        lastTaskId: 'task_reconciliation',
        lastStatus: 'ok',
      }],
    })));
    render(<AutomationsPage />);

    expect(await screen.findByText('Monthly reconciliation')).toBeTruthy();
    expect(screen.getByText('The automation run completed successfully.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Monthly reconciliation' })).toBeTruthy();
  });
});
