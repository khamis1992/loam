import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { API, push } = vi.hoisted(() => ({ API: 'http://localhost:8787', push: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import { BuildLauncher } from '../BuildLauncher';

const apiUrl = (path: string) => `${API}/api${path}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRIEF = 'A budgeting app with a dashboard and monthly spending charts.';

function fillBrief(value: string) {
  const box = screen.getByTestId('build-brief') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value } });
  return box;
}

describe('BuildLauncher', () => {
  it('renders the brief box and the three style chips with swarm selected by default', () => {
    stubFetch(() => json({}));
    render(<BuildLauncher />);

    expect(screen.getByTestId('build-brief')).toBeTruthy();
    expect(screen.getByTestId('build-style-swarm').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('build-style-realswarm')).toBeTruthy();
    expect(screen.getByTestId('build-style-app-builder')).toBeTruthy();
    // Brief is empty: the launch button stays disabled.
    expect((screen.getByTestId('build-launch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the brief to POST /api/swarm/runs and navigates to the team runs list', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === apiUrl('/swarm/runs')) return json({ run: { id: 'swarm_1', status: 'running' } }, 201);
      return json({}, 404);
    });
    render(<BuildLauncher />);

    fillBrief(BRIEF);
    fireEvent.click(screen.getByTestId('build-launch'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/agents'));
    const call = fetchMock.mock.calls.find(([u]) => String(u) === apiUrl('/swarm/runs'));
    expect(call).toBeTruthy();
    expect((call?.[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ brief: BRIEF });
  });

  it('sends the brief as the goal to POST /api/realswarm/runs and shows the created run', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === apiUrl('/realswarm/runs')) return json({ run: { id: 'realswarm_abc', status: 'running' } }, 201);
      return json({}, 404);
    });
    render(<BuildLauncher />);

    fireEvent.click(screen.getByTestId('build-style-realswarm'));
    fillBrief(BRIEF);
    fireEvent.click(screen.getByTestId('build-launch'));

    await waitFor(() => expect(screen.getByTestId('build-realswarm-result')).toBeTruthy());
    expect(screen.getByTestId('build-realswarm-result').textContent).toContain('realswarm_abc');
    // Honest behavior: no navigation claim for realswarm (no dedicated UI surface yet).
    expect(push).not.toHaveBeenCalled();
    const call = fetchMock.mock.calls.find(([u]) => String(u) === apiUrl('/realswarm/runs'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ goal: BRIEF });
  });

  it('creates an app project via POST /api/app-projects and opens the workspace panel', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === apiUrl('/app-projects')) return json({ project: { id: 'ap_1', title: 'A budgeting app with a dashboard and monthly spending charts.' } });
      return json({}, 404);
    });
    render(<BuildLauncher />);

    fireEvent.click(screen.getByTestId('build-style-app-builder'));
    fillBrief(BRIEF);
    fireEvent.click(screen.getByTestId('build-launch'));

    await waitFor(() => expect(screen.getByTestId('build-appbuilder-panel')).toBeTruthy());
    const call = fetchMock.mock.calls.find(([u]) => String(u) === apiUrl('/app-projects'));
    expect(call).toBeTruthy();
    expect((call?.[1] as RequestInit).method).toBe('POST');
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.title).toBe('A budgeting app with a dashboard and monthly spending charts.');
    expect(body.description).toBe(BRIEF);
  });

  it('surfaces engine errors instead of pretending success', async () => {
    stubFetch((url) => {
      if (url === apiUrl('/swarm/runs')) return json({ error: 'Brief must contain 1–20000 characters' }, 400);
      return json({}, 404);
    });
    render(<BuildLauncher />);

    fillBrief(BRIEF);
    fireEvent.click(screen.getByTestId('build-launch'));

    await waitFor(() => expect(screen.getByTestId('build-error')).toBeTruthy());
    expect(screen.getByTestId('build-error').textContent).toContain('Brief must contain 1–20000 characters');
    expect(push).not.toHaveBeenCalled();
  });

  it('switches the selected chip when another style is clicked', () => {
    stubFetch(() => json({}));
    render(<BuildLauncher />);

    fireEvent.click(screen.getByTestId('build-style-app-builder'));
    expect(screen.getByTestId('build-style-app-builder').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('build-style-swarm').getAttribute('aria-checked')).toBe('false');
  });
});
