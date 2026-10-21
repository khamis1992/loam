import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PersonalizationPane } from '../PersonalizationPane';

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

const empty = () => jsonResponse({ personalization: { aboutMe: '', howToRespond: '', updatedAt: '' } });

describe('PersonalizationPane', () => {
  beforeEach(() => { calls = []; });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('loads stored instructions from GET /api/personalization', async () => {
    stubFetch((c) => {
      if (c.method === 'GET') {
        return jsonResponse({ personalization: { aboutMe: 'I work in finance.', howToRespond: 'Be concise.', updatedAt: 'now' } });
      }
      return jsonResponse({});
    });
    render(<PersonalizationPane />);
    expect(await screen.findByDisplayValue('I work in finance.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Be concise.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/api/personalization'))).toBe(true);
  });

  it('saves both fields via POST /api/personalization', async () => {
    stubFetch((c) => {
      if (c.method === 'GET') return empty();
      return jsonResponse({ personalization: { aboutMe: 'Prompt hook tester.', howToRespond: 'Always cite sources.', updatedAt: 'now' } });
    });
    render(<PersonalizationPane />);
    fireEvent.change(await screen.findByLabelText('About you'), { target: { value: 'Prompt hook tester.' } });
    fireEvent.change(screen.getByLabelText('How to respond'), { target: { value: 'Always cite sources.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/personalization'));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({ aboutMe: 'Prompt hook tester.', howToRespond: 'Always cite sources.' });
    });
    expect(await screen.findByText('Instructions saved')).toBeInTheDocument();
  });

  it('shows a load error without crashing when the store is unreachable', async () => {
    stubFetch(() => jsonResponse({ error: 'nope' }, 500));
    render(<PersonalizationPane />);
    expect(await screen.findByText('Could not load your instructions')).toBeInTheDocument();
  });
});
