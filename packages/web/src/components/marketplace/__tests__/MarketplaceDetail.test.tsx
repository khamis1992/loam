import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MarketplaceDetail from '../MarketplaceDetail';
import { MARKETPLACE_CATALOG_URL, type MarketplaceCatalogEntry } from '../types';

function makeEntry(overrides: Partial<MarketplaceCatalogEntry> = {}): MarketplaceCatalogEntry {
  return {
    id: 'bd-test-bot',
    source: ['botdirectory'],
    name: 'Test Bot',
    description: 'Does useful work on a schedule',
    category: 'Operations',
    tags: ['Operations'],
    icon: '',
    iconStyle: { monogram: 'T', categoryColor: 'Operations' },
    instructions: 'Handle the work. Do it well.',
    tools: ['Notion', 'Gmail'],
    toolUrls: { Notion: 'https://notion.so' },
    skills: [
      { name: 'Weekly review', description: 'Summarize the week', content: 'Long form content for the weekly review skill.' },
      { name: 'Inbox zero', description: 'Clear the inbox', content: 'Clear the inbox daily.' },
    ],
    memories: ['Prefers concise replies'],
    routines: [{ name: 'Morning digest', summary: 'Every morning, summarize overnight activity' }],
    author: { name: 'benln', url: 'https://x.com/benln' },
    installCount: 1200,
    addedAt: '2026-01-01T00:00:00.000Z',
    sourceUrl: 'https://botdirectory.ai/bots/test-bot/',
    license: 'MIT (Copyright (c) 2026 Inbox Zero Inc.) — repo license',
    ...overrides,
  };
}

function makeRelated(id: string, name: string): MarketplaceCatalogEntry {
  return makeEntry({ id, name, description: `Related bot ${name}` });
}

describe('MarketplaceDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('renders every MARKETPLACE_SPEC 3.2 section for a botdirectory entry', () => {
    const entry = makeEntry();
    const catalog = [entry, makeRelated('bd-a', 'Alpha Bot'), makeRelated('bd-b', 'Bravo Bot'), makeRelated('bd-c', 'Charlie Bot')];
    render(<MarketplaceDetail entry={entry} catalog={catalog} onClose={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: 'Test Bot' });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Marketplace');
    expect(dialog.textContent).toContain('Operations');
    expect(screen.getByText('Test Bot')).toBeTruthy();
    expect(screen.getByText('1.2k adds')).toBeTruthy();
    expect(screen.getByText('by benln')).toBeTruthy();
    expect(screen.getByText('Instructions')).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toContain('Handle the work. Do it well.');
    expect(screen.getByText('Connect first')).toBeTruthy();
    expect(screen.getByText('Notion')).toBeTruthy();
    expect(screen.getByText('Gmail')).toBeTruthy();
    expect(screen.getByText('Skills (2)')).toBeTruthy();
    expect(screen.getByText('Weekly review')).toBeTruthy();
    expect(screen.getByText('Routines (1)')).toBeTruthy();
    expect(screen.getByText('Morning digest')).toBeTruthy();
    expect(screen.getByText('Source')).toBeTruthy();
    expect(screen.getByText('botdirectory.ai')).toBeTruthy();
    expect(screen.getByText('Related bots')).toBeTruthy();
    expect(screen.getByText('Alpha Bot')).toBeTruthy();
    expect(screen.getByText('Bravo Bot')).toBeTruthy();
    expect(screen.getByText('Charlie Bot')).toBeTruthy();
  });

  it('links the Notion chip to its integration url', () => {
    render(<MarketplaceDetail entry={makeEntry()} catalog={[makeEntry()]} onClose={() => {}} />);
    expect(screen.getByText('Notion').closest('a')?.getAttribute('href')).toBe('https://notion.so');
  });

  it('composes instructions and shows x.ai attribution for xai entries', () => {
    const entry = makeEntry({
      id: 'xai-test-bot',
      source: ['xai'],
      instructions: '',
      installCount: 0,
      author: { name: 'Anoop', handle: 'akbaliga96' },
      addHref: 'https://x.ai/bot/abc',
      sourceUrl: 'https://x.ai/bot/marketplace/bots/abc',
    });
    render(<MarketplaceDetail entry={entry} catalog={[entry]} onClose={() => {}} />);

    const pre = document.querySelector('pre')?.textContent ?? '';
    expect(pre).toContain('Does useful work on a schedule');
    expect(pre).toContain('## Skills');
    expect(pre).toContain('### Weekly review');
    expect(pre).toContain('## Memory');
    expect(pre).toContain('- Prefers concise replies');
    expect(screen.queryByText(/adds/)).toBeNull();
    expect(screen.getByText('by @akbaliga96')).toBeTruthy();
    expect(screen.getByText('Add on x.ai').closest('a')?.getAttribute('href')).toBe('https://x.ai/bot/abc');
  });

  it('falls back to the no-prompt placeholder when nothing can be composed', () => {
    const entry = makeEntry({
      description: '',
      instructions: '',
      skills: [],
      memories: [],
      tools: [],
      routines: [],
    });
    render(<MarketplaceDetail entry={entry} catalog={[entry]} onClose={() => {}} />);
    expect(screen.getByText('This bot has no public prompt.')).toBeTruthy();
    expect(screen.queryByText('Connect first')).toBeNull();
    expect(screen.queryByText('Routines (1)')).toBeNull();
  });

  it('copies the prompt and flips the button label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MarketplaceDetail entry={makeEntry()} catalog={[makeEntry()]} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Handle the work. Do it well.'));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('calls onAdd with the entry and shows pending and added states', () => {
    const onAdd = vi.fn();
    const { rerender } = render(
      <MarketplaceDetail entry={makeEntry()} catalog={[makeEntry()]} onClose={() => {}} onAdd={onAdd} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Test Bot' }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'bd-test-bot' }));

    rerender(
      <MarketplaceDetail
        entry={makeEntry()}
        catalog={[makeEntry()]}
        onClose={() => {}}
        onAdd={onAdd}
        pending
      />,
    );
    const pendingButton = screen.getByText('Adding…').closest('button') as HTMLButtonElement;
    expect(pendingButton).toBeTruthy();
    expect(pendingButton.disabled).toBe(true);

    const onOpenAgent = vi.fn();
    rerender(
      <MarketplaceDetail
        entry={makeEntry()}
        catalog={[makeEntry()]}
        onClose={() => {}}
        installedAgentId="agent-1"
        onOpenAgent={onOpenAgent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenAgent).toHaveBeenCalledWith('agent-1');
    expect(screen.getByText('Added')).toBeTruthy();
  });

  it('opens a skill in the accordion', () => {
    render(<MarketplaceDetail entry={makeEntry()} catalog={[makeEntry()]} onClose={() => {}} />);
    const summary = screen.getByText('Weekly review');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
  });

  it('fetches the bundled catalog itself for related bots when no catalog is passed', async () => {
    const entry = makeEntry();
    const others = [makeRelated('bd-a', 'Alpha Bot'), makeRelated('bd-b', 'Bravo Bot'), makeRelated('bd-c', 'Charlie Bot')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([entry, ...others]), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    render(<MarketplaceDetail entry={entry} onClose={() => {}} />);

    expect(await screen.findByText('Related bots')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Alpha Bot')).toBeTruthy());
    expect(screen.getByText('Charlie Bot')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(MARKETPLACE_CATALOG_URL);
  });

  it('opens a related bot and closes via Escape and the scrim', () => {
    const entry = makeEntry();
    const catalog = [entry, makeRelated('bd-a', 'Alpha Bot'), makeRelated('bd-b', 'Bravo Bot'), makeRelated('bd-c', 'Charlie Bot')];
    const onOpenEntry = vi.fn();
    const onClose = vi.fn();
    render(<MarketplaceDetail entry={entry} catalog={catalog} onClose={onClose} onOpenEntry={onOpenEntry} />);

    fireEvent.click(screen.getByText('Alpha Bot'));
    expect(onOpenEntry).toHaveBeenCalledWith(expect.objectContaining({ id: 'bd-a' }));

    const [scrim, headerClose] = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(headerClose);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});