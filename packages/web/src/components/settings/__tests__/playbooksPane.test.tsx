import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlaybooksPane } from '../PlaybooksPane';
import type { Playbook, PlaybookVersion } from '@/services/playbooksApi';

interface Call { url: string; method: string; body?: Record<string, unknown> }

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: Call = { url, method, body };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch);
}

function playbook(over: Partial<Playbook> = {}): Playbook {
  return {
    id: 'pb_1',
    name: 'Release checklist',
    macro: 'release_checklist',
    overview: 'Ship a build safely.',
    procedure: '1. build\n2. verify',
    specifications: '',
    advice: '',
    forbiddenActions: '',
    neededFromUser: '',
    currentVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function version(over: Partial<PlaybookVersion> = {}): PlaybookVersion {
  return {
    id: 'pbv_1',
    playbookId: 'pb_1',
    version: 1,
    overview: 'Ship a build safely.',
    procedure: '1. build\n2. verify',
    specifications: '',
    advice: '',
    forbiddenActions: '',
    neededFromUser: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const listResponse = () => jsonResponse({ playbooks: [playbook()] });

describe('PlaybooksPane (D9)', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists playbooks from GET /api/playbooks with their macro and version', async () => {
    stubFetch((c) => {
      if (c.method === 'GET' && c.url.includes('/api/playbooks')) return listResponse();
      return jsonResponse({});
    });
    render(<PlaybooksPane />);
    expect(await screen.findByText('Release checklist')).toBeInTheDocument();
    expect(screen.getByText('!release_checklist · v1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^View$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^History$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
  });

  it('validates the name and macro before creating a playbook', async () => {
    stubFetch((c) => {
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<PlaybooksPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Create playbook/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText(/Name is required/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(screen.getByLabelText('Playbook name'), { target: { value: 'Release checklist' } });
    fireEvent.change(screen.getByLabelText('Macro'), { target: { value: '!!Bad Macro' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText(/Macro must be lowercase/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a playbook via POST /api/playbooks, normalizing the macro', async () => {
    stubFetch((c) => {
      if (c.method === 'POST') return jsonResponse({ playbook: playbook({ id: 'pb_2', name: 'DB migration', macro: 'db_migration' }) }, 201);
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<PlaybooksPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Create playbook/ }));
    fireEvent.change(screen.getByLabelText('Playbook name'), { target: { value: 'DB migration' } });
    fireEvent.change(screen.getByLabelText('Macro'), { target: { value: '!DB_Migration' } });
    fireEvent.change(screen.getByLabelText('Overview'), { target: { value: 'Migrate the schema.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/playbooks'));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({ name: 'DB migration', macro: 'db_migration', overview: 'Migrate the schema.' });
    });
  });

  it('views a playbook via GET /api/playbooks/:id', async () => {
    stubFetch((c) => {
      if (c.url.includes('/api/playbooks/pb_1/versions')) return jsonResponse({ versions: [] });
      if (c.url.includes('/api/playbooks/pb_1')) return jsonResponse({ playbook: playbook() });
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<PlaybooksPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^View$/ }));
    expect(await screen.findByText('Playbook details')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('Ship a build safely.')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /^Edit$/ }).length).toBeGreaterThan(0);
  });

  it('edits a playbook via PATCH /api/playbooks/:id', async () => {
    stubFetch((c) => {
      if (c.url.includes('/api/playbooks/pb_1') && c.method === 'GET') return jsonResponse({ playbook: playbook() });
      if (c.method === 'PATCH') return jsonResponse({ playbook: playbook({ currentVersion: 2 }) });
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<PlaybooksPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Ship a build safely.')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Procedure'), { target: { value: '1. build\n2. verify\n3. ship' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/api/playbooks/pb_1'));
      expect(patch).toBeTruthy();
      expect(String(patch!.body!.procedure)).toContain('ship');
      expect(patch!.body).toMatchObject({ name: 'Release checklist', macro: 'release_checklist' });
    });
  });

  it('deletes a playbook via DELETE /api/playbooks/:id after confirmation', async () => {
    stubFetch((c) => {
      if (c.method === 'DELETE') return jsonResponse({ deleted: true });
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<PlaybooksPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    const confirmButtons = await screen.findAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.url.includes('/api/playbooks/pb_1'));
      expect(del).toBeTruthy();
    });
  });

  it('shows version history and restores a historical version', async () => {
    const older = version({ id: 'pbv_1', version: 1, procedure: '1. build' });
    const newer = version({ id: 'pbv_2', version: 2, procedure: '1. build\n2. verify', createdBy: 'session:t_9' });
    stubFetch((c) => {
      if (c.url.includes('/versions/1/restore') && c.method === 'POST') return jsonResponse({ playbook: playbook({ currentVersion: 3 }) });
      if (c.url.includes('/api/playbooks/pb_1/versions')) return jsonResponse({ versions: [newer, older] });
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<PlaybooksPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^History$/ }));
    expect(await screen.findByText('Version history')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/session:t_9/)).toBeInTheDocument());
    const restoreButtons = screen.getAllByRole('button', { name: /^Restore$/ });
    fireEvent.click(restoreButtons[restoreButtons.length - 1]);
    await waitFor(() => {
      const restore = calls.find((c) => c.method === 'POST' && c.url.includes('/versions/1/restore'));
      expect(restore).toBeTruthy();
    });
  });
});
