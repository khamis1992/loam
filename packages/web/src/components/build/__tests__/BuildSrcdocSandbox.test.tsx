import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
}));

import { setLocale } from '@/i18n/t';
import { BuildMenuEntry } from '../BuildMenuEntry';

const SRCDOC_SANDBOX = 'allow-scripts';
const LEASED_SANDBOX = 'allow-scripts allow-same-origin';

beforeEach(() => {
  setLocale('ar');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  setLocale('en');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jobPayload(url: string, body: { operation?: { action?: string } }, preview: Record<string, unknown>): Record<string, unknown> {
  if (url.endsWith('/projects')) return { projectId: 'app_bcdfghjkmnpq', revision: 1 };
  if (url.endsWith('/grants')) return { grantId: 'a'.repeat(64) };
  if (url.endsWith('/jobs') && body.operation?.action === 'preview') return preview;
  if (url.endsWith('/jobs')) {
    return {
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      jobId: 'job_1',
      engine: 'loam-game',
      summary: 'canvas',
      previewHtml: '<canvas id="static"></canvas>',
    };
  }
  return {};
}

async function prepareGame(preview: Record<string, unknown>): Promise<ReturnType<typeof render>> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    return new Response(JSON.stringify(jobPayload(url, body, preview)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const view = render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر الألعاب' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'لعبة محلية بهدف قريب على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  await screen.findByTitle('عاين المشروع');
  return view;
}

test('a srcdoc preview sandbox is exactly allow-scripts', async () => {
  const view = await prepareGame({});
  const frame = screen.getByTitle('عاين المشروع');
  expect(frame.tagName).toBe('IFRAME');
  expect(frame.getAttribute('sandbox')).toBe(SRCDOC_SANDBOX);
  expect(frame.getAttribute('sandbox')?.split(/\s+/)).toEqual(['allow-scripts']);
  expect(frame.getAttribute('srcdoc')).toContain('<canvas id="static">');
  expect(frame.hasAttribute('src')).toBe(false);
  view.unmount();
});

test('a leased preview sandbox is allow-scripts allow-same-origin', async () => {
  const view = await prepareGame({
    projectId: 'app_bcdfghjkmnpq',
    revision: 1,
    jobId: 'job_live',
    engine: 'loam-game',
    summary: 'canvas',
    previewUrl: 'http://127.0.0.1:9/',
  });
  expect(screen.getByTitle('عاين المشروع').getAttribute('sandbox')).toBe(SRCDOC_SANDBOX);
  fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
  await waitFor(() => {
    const frame = screen.getByTitle('عاين المشروع');
    const tokens = frame.getAttribute('sandbox')?.split(/\s+/) ?? [];
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:9/');
    expect(frame.getAttribute('sandbox')).toBe(LEASED_SANDBOX);
    expect(tokens).toEqual(['allow-scripts', 'allow-same-origin']);
    expect(tokens).toContain('allow-same-origin');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
  });
  expect(screen.getAllByTitle('عاين المشروع')).toHaveLength(1);
  view.unmount();
});
