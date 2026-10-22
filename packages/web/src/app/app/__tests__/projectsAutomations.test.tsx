import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import ProjectsPage from '../projects/page';
import AutomationsPage from '../automations/page';

const apiUrl = (path: string) => `${API}/api${path}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProjectsPage create/edit/delete dialogs', () => {
  it('opens the create dialog from the header with name, instruction and folder fields', async () => {
    stubFetch(() => json({ projects: [] }));
    render(<ProjectsPage />);
    expect(await screen.findByText('Projects')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /New project/ }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByPlaceholderText('Project name')).toBeTruthy();
    expect(within(dialog).getByPlaceholderText('Project instruction (optional)')).toBeTruthy();
    expect(within(dialog).getByPlaceholderText('Project folder (optional)')).toBeTruthy();
  });

  it('creates a project through POST /api/projects', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/projects') && init?.method === 'POST') {
        return json({ project: { id: 'p1', name: 'Alpha', instruction: 'ship it' } });
      }
      return json({ projects: [{ id: 'p1', name: 'Alpha', instruction: 'ship it' }] });
    });
    render(<ProjectsPage />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: /New project/ }));
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/projects'),
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Alpha', instruction: '' }) }),
      ),
    );
  });

  it('edits an existing project through POST /api/projects/:id', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/projects/p1') && init?.method === 'POST') {
        return json({ project: { id: 'p1', name: 'Renamed', instruction: 'v2' } });
      }
      return json({ projects: [{ id: 'p1', name: 'Alpha', instruction: 'v1' }] });
    });
    render(<ProjectsPage />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit project' });
    const name = within(dialog).getByPlaceholderText('Project name') as HTMLInputElement;
    expect(name.value).toBe('Alpha');
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/projects/p1'),
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Renamed', instruction: 'v1' }) }),
      ),
    );
  });

  it('deletes a project through DELETE /api/projects/:id after confirming', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/projects/p1') && init?.method === 'DELETE') return json({ deleted: true });
      return json({ projects: [{ id: 'p1', name: 'Alpha', instruction: '' }] });
    });
    render(<ProjectsPage />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(apiUrl('/projects/p1'), expect.objectContaining({ method: 'DELETE' })),
    );
  });
});

describe('AutomationsPage create/edit/delete dialogs', () => {
  it('opens the create dialog from the header', async () => {
    stubFetch(() => json({ schedules: [] }));
    render(<AutomationsPage />);
    expect(await screen.findByText('Automations')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /New automation/ }));
    const dialog = screen.getByRole('dialog', { name: 'New automation' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByPlaceholderText('What should Loam do?')).toBeTruthy();
  });

  it('creates an automation through POST /api/schedules', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/schedules') && init?.method === 'POST') {
        return json({ schedule: { id: 's1', prompt: 'Nightly sync', intervalSeconds: 3600, enabled: true } });
      }
      return json({ schedules: [{ id: 's1', prompt: 'Nightly sync', intervalSeconds: 3600, enabled: true }] });
    });
    render(<AutomationsPage />);
    await screen.findByText('Nightly sync');

    fireEvent.click(screen.getByRole('button', { name: /New automation/ }));
    fireEvent.change(screen.getByPlaceholderText('What should Loam do?'), { target: { value: 'Nightly sync' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/schedules'),
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ prompt: 'Nightly sync', intervalSeconds: 3600 }) }),
      ),
    );
  });

  it('edits an existing automation through PATCH /api/schedules/:id', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/schedules/s1') && init?.method === 'PATCH') {
        return json({ schedule: { id: 's1', prompt: 'Renamed routine', intervalSeconds: 3600, enabled: true } });
      }
      return json({ schedules: [{ id: 's1', prompt: 'Nightly sync', intervalSeconds: 3600, enabled: true }] });
    });
    render(<AutomationsPage />);
    await screen.findByText('Nightly sync');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit automation' });
    const prompt = within(dialog).getByPlaceholderText('What should Loam do?') as HTMLTextAreaElement;
    expect(prompt.value).toBe('Nightly sync');
    fireEvent.change(prompt, { target: { value: 'Renamed routine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/schedules/s1'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ prompt: 'Renamed routine' }) }),
      ),
    );
  });

  it('toggles an automation through PATCH /api/schedules/:id', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/schedules/s1') && init?.method === 'PATCH') {
        return json({ schedule: { id: 's1', prompt: 'Nightly sync', intervalSeconds: 3600, enabled: false } });
      }
      return json({ schedules: [{ id: 's1', prompt: 'Nightly sync', intervalSeconds: 3600, enabled: true }] });
    });
    render(<AutomationsPage />);
    await screen.findByText('Nightly sync');

    fireEvent.click(screen.getByRole('switch', { name: 'Disable' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        apiUrl('/schedules/s1'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
      ),
    );
  });

  it('runs an automation now through POST /api/schedules/:id/run-now', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/schedules/s1/run-now') && init?.method === 'POST') {
        return json({ started: true, scheduleId: 's1' });
      }
      return json({ schedules: [{ id: 's1', prompt: 'Nightly sync', intervalSeconds: 3600, enabled: true }] });
    });
    render(<AutomationsPage />);
    await screen.findByText('Nightly sync');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(apiUrl('/schedules/s1/run-now'), expect.objectContaining({ method: 'POST' })),
    );
  });

  it('deletes an automation through DELETE /api/schedules/:id after confirming', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === apiUrl('/schedules/s1') && init?.method === 'DELETE') return json({ deleted: true });
      return json({ schedules: [{ id: 's1', prompt: 'Nightly sync', intervalSeconds: 3600, enabled: true }] });
    });
    render(<AutomationsPage />);
    await screen.findByText('Nightly sync');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(apiUrl('/schedules/s1'), expect.objectContaining({ method: 'DELETE' })),
    );
  });
});
