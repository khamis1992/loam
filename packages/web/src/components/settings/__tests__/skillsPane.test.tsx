import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillsPane } from '../SkillsPane';

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

const summary = { slug: 'release-check', name: 'release-check', description: 'Check a release build', version: 1, uses: 0, successes: 0, failures: 0, partials: 0, successRate: 0, lastUsed: null, updatedAt: '2026-01-01T00:00:00.000Z', tags: [] };
const detail = { ...summary, path: 'skills/release-check/SKILL.md', source: 'disk', body: '# Steps\n1. build' };

const listResponse = () => jsonResponse({ skills: [summary] });
const detailResponse = () => jsonResponse(detail);

describe('SkillsPane (memory-skills backend)', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists skills from GET /api/memory-skills', async () => {
    stubFetch((c) => {
      if (c.method === 'GET' && c.url.includes('/api/memory-skills')) return listResponse();
      return jsonResponse({});
    });
    render(<SkillsPane />);
    expect(await screen.findByText('release-check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^View$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
  });

  it('validates required instructions before creating a skill', async () => {
    stubFetch((c) => {
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Create skill/ }));
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'my-skill' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'does a thing' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText('Instructions are required.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a skill via POST /api/memory-skills with name, description and body', async () => {
    stubFetch((c) => {
      if (c.method === 'POST') return jsonResponse({ ok: true, slug: 'my-skill', version: 1, action: 'created', message: 'created' });
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Create skill/ }));
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'my-skill' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'does a thing' } });
    fireEvent.change(screen.getByLabelText(/Instructions/), { target: { value: '# my-skill\n## Steps\n1. go' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/memory-skills'));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({ name: 'my-skill', description: 'does a thing' });
      expect(String(post!.body!.body)).toContain('Steps');
    });
  });

  it('views a skill via GET /api/memory-skills/:slug', async () => {
    stubFetch((c) => {
      if (c.url.includes('/api/memory-skills/release-check')) return detailResponse();
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^View$/ }));
    expect(await screen.findByText('Skill details')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('Check a release build')).toBeInTheDocument());
  });

  it('edits a skill via PUT /api/memory-skills/:slug', async () => {
    stubFetch((c) => {
      if (c.url.includes('/api/memory-skills/release-check') && c.method === 'GET') return detailResponse();
      if (c.method === 'PUT') return jsonResponse({ ok: true, slug: 'release-check', version: 2, action: 'updated', message: 'updated' });
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }));
    await waitFor(() => expect(screen.getByDisplayValue('Check a release build')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Instructions/), { target: { value: '# Steps\n1. build\n2. ship' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/memory-skills/release-check'));
      expect(put).toBeTruthy();
      expect(String(put!.body!.body)).toContain('ship');
    });
  });

  it('deletes a skill via DELETE /api/memory-skills/:slug after confirmation', async () => {
    stubFetch((c) => {
      if (c.method === 'DELETE') return jsonResponse({ ok: true, slug: 'release-check' });
      if (c.method === 'GET') return listResponse();
      return jsonResponse({});
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    const confirmButtons = await screen.findAllByRole('button', { name: /^Delete$/ });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.url.includes('/api/memory-skills/release-check'));
      expect(del).toBeTruthy();
    });
  });
});
