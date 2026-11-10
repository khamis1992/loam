import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { setLocale } from '@/i18n/t';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
}));

import LibraryPage from '../page';

const entries = [
  { taskId: 'task_docs', name: 'report.pdf', path: 'output/report.pdf', size: 2048, mtime: '2026-01-01T00:00:00.000Z' },
  { taskId: 'task_images', name: 'cover.png', path: 'output/cover.png', size: 4096, mtime: '2026-01-03T00:00:00.000Z' },
  { taskId: 'task_audio', name: 'notes.mp3', path: 'output/notes.mp3', size: 1024, mtime: '2026-01-02T00:00:00.000Z' },
  { taskId: 'task_websites', name: 'index.html', path: 'site/index.html', size: 512, mtime: '2026-01-04T00:00:00.000Z' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFiles(response = entries) {
  const mock = vi.fn(async () => json({ entries: response }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  setLocale('en');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LibraryPage Manus Studio layout', () => {
  it('shows the category tabs, search, sorting and grid controls', async () => {
    setLocale('en');
    stubFiles();
    render(<LibraryPage />);

    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Library' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Library categories' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Text & PDF' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mobile apps' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Sort files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('library-grid')).toBeTruthy();
  });

  it('filters by category and file search', async () => {
    stubFiles();
    render(<LibraryPage />);
    await screen.findByText('report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    expect(screen.getByText('cover.png')).toBeTruthy();
    expect(screen.queryByText('report.pdf')).toBeNull();
    expect(screen.queryByText('notes.mp3')).toBeNull();
    const preview = document.querySelector('img');
    expect(preview).not.toBeNull();
    fireEvent.error(preview!);
    expect(document.querySelector('img')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'notes' } });
    expect(screen.getByText('notes.mp3')).toBeTruthy();
    expect(screen.queryByText('cover.png')).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'missing' } });
    expect(screen.getByText('No files match your search.')).toBeTruthy();
  });

  it('switches to list view and sorts files by name', async () => {
    stubFiles();
    render(<LibraryPage />);
    await screen.findByText('report.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByTestId('library-list')).toBeTruthy();
    expect(screen.queryByTestId('library-grid')).toBeNull();
    expect(screen.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort files' }), { target: { value: 'name' } });
    const links = within(screen.getByTestId('library-list')).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining('cover.png'),
      expect.stringContaining('index.html'),
      expect.stringContaining('notes.mp3'),
      expect.stringContaining('report.pdf'),
    ]);
  });

  it('retries after a loading failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ entries }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LibraryPage />);

    expect(await screen.findByText('Failed to load library')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
