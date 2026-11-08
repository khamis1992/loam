import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
}));

import { setLocale } from '@/i18n/t';
import { BuildMenuEntry } from '../BuildMenuEntry';

beforeEach(() => {
  setLocale('ar');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  setLocale('en');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function payload(url: string, preview: Record<string, unknown> | null): Record<string, unknown> {
  if (preview && url.endsWith('/jobs')) return preview;
  if (url.endsWith('/projects')) return { projectId: 'app_bcdfghjkmnpq', revision: 1 };
  if (url.endsWith('/grants')) return { grantId: 'a'.repeat(64) };
  if (url.endsWith('/jobs')) return { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_1', engine: 'loam-game', summary: 'canvas' };
  return {};
}

async function prepareGame(): Promise<void> {
  render(<BuildMenuEntry enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'اختر الألعاب' }));
  fireEvent.change(screen.getByTestId('build-menu-brief'), { target: { value: 'لعبة محلية بهدف قريب على هذا الجهاز' } });
  fireEvent.click(screen.getByRole('button', { name: 'جهّز المشروع' }));
  await screen.findByRole('button', { name: 'عاين المشروع' });
}

test('going back while a preview is starting stays stopping and drops the late page', async () => {
  const urls: string[] = [];
  let release: (value: Response) => void = () => undefined;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    if (url.endsWith('/jobs') && body.operation?.action === 'preview') return held;
    return new Response(JSON.stringify(payload(url, null)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await prepareGame();
  fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
  fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
  expect((await screen.findByTestId('build-preview-stopping')).textContent).toContain('لن تصبح جاهزة');
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
  release(new Response(JSON.stringify({
    projectId: 'app_bcdfghjkmnpq',
    revision: 1,
    jobId: 'job_late',
    engine: 'loam-game',
    summary: 'canvas',
    phase: 'running',
    previewUrl: 'http://127.0.0.1:9/',
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await waitFor(() => {
    expect(urls.filter((url) => url.endsWith('/jobs/job_late/cancel'))).toHaveLength(1);
  });
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
  expect(screen.queryByTestId('build-preview-stopping')).toBeNull();
});

test('a stopping preview with another revision never becomes ready', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const preview = url.endsWith('/jobs') && body.operation?.action === 'preview'
      ? { projectId: 'app_bcdfghjkmnpq', revision: 9, jobId: 'job_stale', engine: 'loam-game', summary: 'canvas', phase: 'stopping', previewUrl: 'http://127.0.0.1:9/' }
      : null;
    return new Response(JSON.stringify(payload(url, preview)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await prepareGame();
  fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
  expect((await screen.findByTestId('build-preview-stopping')).textContent).toContain('لن تصبح جاهزة');
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
  await waitFor(() => {
    expect(urls.filter((url) => url.endsWith('/jobs/job_stale/cancel'))).toHaveLength(1);
  });
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
});

test('a cancelled package is not shown as saved', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const preview = url.endsWith('/jobs') && body.operation?.action === 'package'
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_pack', engine: 'loam-game', summary: 'zip', phase: 'cancelled', artifactId: 'artifact_late' }
      : null;
    return new Response(JSON.stringify(payload(url, preview)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await prepareGame();
  fireEvent.click(screen.getByRole('button', { name: 'صدّر المصدر' }));
  expect((await screen.findByRole('alert')).textContent).toContain('لم يُحفظ شيء جديد');
  expect(screen.queryByText('artifact_late')).toBeNull();
});

test('publish shows the local handoff and does not call the server', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const url = String(input);
    return new Response(JSON.stringify(payload(url, null)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await prepareGame();
  const before = urls.length;
  fireEvent.click(screen.getByRole('button', { name: 'نشر' }));
  expect(screen.getByTestId('build-publish-handoff').textContent).toContain('لم يُرفع شيء');
  expect(screen.getByTestId('build-publish-handoff').textContent).toContain('لم يُثبَّت محرك');
  expect(urls).toHaveLength(before);
  expect(urls.some((url) => url.includes('publish'))).toBe(false);
});

test('a file preview is not opened in the frame', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const preview = url.endsWith('/jobs') && body.operation?.action === 'preview'
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_file', engine: 'loam-game', summary: 'canvas', phase: 'running', previewUrl: 'file:///C:/secret.html' }
      : null;
    return new Response(JSON.stringify(payload(url, preview)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await prepareGame();
  fireEvent.click(screen.getByRole('button', { name: 'عاين المشروع' }));
  expect((await screen.findByTestId('build-preview-origin')).textContent).toContain('لم تُفتح');
  expect(screen.queryByTitle('عاين المشروع')).toBeNull();
});

test('showing a file passes only the project and artifact ids', async () => {
  const seen: unknown[] = [];
  (window as unknown as { __apis?: unknown }).__apis = {
    buildMenu: { revealArtifact: vi.fn(async (body: unknown) => { seen.push(body); }) },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { operation?: { action?: string } } : {};
    const packed = url.endsWith('/jobs') && body.operation?.action === 'package'
      ? { projectId: 'app_bcdfghjkmnpq', revision: 1, jobId: 'job_pack', engine: 'loam-game', summary: 'zip', phase: 'running', artifactId: 'art_01234567-89ab-cdef-0123-456789abcdef' }
      : null;
    return new Response(JSON.stringify(payload(url, packed)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  try {
    await prepareGame();
    fireEvent.click(screen.getByRole('button', { name: 'صدّر المصدر' }));
    fireEvent.click(await screen.findByRole('button', { name: 'أظهر الملف' }));
    await waitFor(() => expect(seen).toEqual([{ projectId: 'app_bcdfghjkmnpq', artifactId: 'art_01234567-89ab-cdef-0123-456789abcdef' }]));
    expect(JSON.stringify(seen[0])).not.toContain('path');
    expect(screen.queryByTestId('build-reveal-note')).toBeNull();
  } finally {
    delete (window as unknown as { __apis?: unknown }).__apis;
  }
});
