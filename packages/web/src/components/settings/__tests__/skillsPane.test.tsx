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

const emptyCatalog = () => jsonResponse({ source: 'aitmpl.com', total: 0, shown: 0, skills: [] });

describe('SkillsPane', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists installed skills from GET /api/skills', async () => {
    stubFetch((c) => {
      if (c.method === 'GET' && c.url.includes('/api/skills/catalog')) return emptyCatalog();
      if (c.method === 'GET' && c.url.includes('/api/skills')) return jsonResponse({ skills: [{ name: 'release-check', description: 'Check a release build' }] });
      return jsonResponse({});
    });
    render(<SkillsPane />);
    expect(await screen.findByText('release-check')).toBeInTheDocument();
    expect(screen.getByText('skills/release-check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^View$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Uninstall/ })).toBeInTheDocument();
  });

  it('validates required instructions before creating a skill', async () => {
    stubFetch((c) => {
      if (c.method === 'GET' && c.url.includes('/api/skills/catalog')) return emptyCatalog();
      return jsonResponse({ skills: [] });
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Create skill/ }));
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'my-skill' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'does a thing' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText('Instructions are required.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a skill via POST /api/skills/create with name, description and content', async () => {
    stubFetch((c) => {
      if (c.method === 'POST') return jsonResponse({ ok: true, message: 'created' });
      if (c.method === 'GET' && c.url.includes('/api/skills/catalog')) return emptyCatalog();
      return jsonResponse({ skills: [{ name: 'my-skill', description: 'does a thing' }] });
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Create skill/ }));
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'my-skill' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'does a thing' } });
    fireEvent.change(screen.getByLabelText(/Instructions/), { target: { value: '# my-skill\n## Steps\n1. go' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/skills/create'));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({ name: 'my-skill', description: 'does a thing' });
      expect(String(post!.body!.content)).toContain('Steps');
    });
  });

  it('installs a catalog skill via POST /api/skills/install', async () => {
    stubFetch((c) => {
      if (c.method === 'POST' && c.url.includes('/api/skills/install')) return jsonResponse({ id: 'dev/pdf', name: 'pdf', dir: 'skills/pdf', files: ['SKILL.md'] });
      if (c.method === 'GET' && c.url.includes('/api/skills/catalog')) return jsonResponse({ source: 'aitmpl.com', total: 3, shown: 1, skills: [{ id: 'dev/pdf', files: 2, description: 'Work with pdfs' }] });
      if (c.method === 'GET') return jsonResponse({ skills: [] });
      return jsonResponse({});
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /Skill catalog/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Install$/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/skills/install'));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({ id: 'dev/pdf', force: false });
    });
  });

  it('views a skill via GET /api/skills/one', async () => {
    stubFetch((c) => {
      if (c.url.includes('/api/skills/one')) return jsonResponse({ name: 'release-check', description: 'Check a release build', body: '# Steps\n1. build' });
      if (c.method === 'GET' && c.url.includes('/api/skills/catalog')) return emptyCatalog();
      if (c.method === 'GET') return jsonResponse({ skills: [{ name: 'release-check', description: 'Check a release build' }] });
      return jsonResponse({});
    });
    render(<SkillsPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^View$/ }));
    expect(await screen.findByText('Skill details')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('Check a release build')).toBeInTheDocument());
  });
});
