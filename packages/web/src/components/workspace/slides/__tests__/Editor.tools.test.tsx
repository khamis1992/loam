import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Editor from '../Editor';
import type { WorkspaceFile, WorkspaceEditorProps } from '../../types';

/** Wave A5+B5 tools on the slides editor: add-slide, find-in-deck, PNG preview
 * toggle, word count, print, and the removal of the redundant raw-save fetch.
 * Network access is stubbed per test with `vi.stubGlobal('fetch', …)`; the
 * default locale is English, so `t()` falls back to the English key text. */

interface TestSlide {
  id: string;
  title: string;
  body: string;
  notes: string;
  background: string;
  accent: string;
  textBoxes?: Array<Record<string, unknown>>;
}

interface TestDeck {
  kind: 'presentation';
  title: string;
  revision: number;
  content: { slides: TestSlide[] };
}

const file: WorkspaceFile = { taskId: 'task_1', path: 'case/deck.pptx', name: 'deck.pptx', kind: 'slides' };

const slide = (id: string, title: string, body: string, notes = ''): TestSlide => ({
  id, title, body, notes, background: '#FFFFFF', accent: '#386bca',
});

/** s1 = 4 words, s2 = 4 words (contains "hello" in the body), s3 = 5 words (contains "hello" in the notes). */
const baseDeck = (): TestDeck => ({
  kind: 'presentation',
  title: 'Deck',
  revision: 4,
  content: {
    slides: [
      slide('s1', 'Alpha One', 'First body'),
      slide('s2', 'Beta', 'Second body hello'),
      slide('s3', 'Gamma', 'Third body', 'hello again'),
    ],
  },
});

/** Duplicating slide 0 server-side yields a fresh id (s4) in the slot after it. */
const duplicatedDeck = (): TestDeck => ({
  ...baseDeck(),
  content: { slides: [slide('s1', 'Alpha One', 'First body'), slide('s4', 'Alpha One', 'First body'), slide('s2', 'Beta', 'Second body hello'), slide('s3', 'Gamma', 'Third body', 'hello again')] },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const method = (init?: RequestInit) => init?.method ?? 'GET';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetch(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Serves the deck for the initial GET and throws on anything the test does not expect. */
function deckOnlyHandler(deck: TestDeck): Handler {
  return (url, init) => {
    if (url.includes('/api/workspace/slides/file') && method(init) === 'GET') return json({ artifact: deck });
    throw new Error(`unexpected fetch ${method(init)} ${url}`);
  };
}

function propsFor(overrides: Partial<WorkspaceEditorProps> = {}): WorkspaceEditorProps {
  return { file, live: false, onSave: vi.fn(async () => {}), onChatEdit: () => {}, ...overrides };
}

const callsTo = (fetchMock: ReturnType<typeof installFetch>, needle: string, verb?: string) =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).includes(needle) && (!verb || method(init as RequestInit | undefined) === verb));

const bodyOf = (call: unknown[]): Record<string, unknown> => JSON.parse((call[1] as RequestInit).body as string);

const originalPrint = window.print;

describe('slides Editor tools', () => {
  beforeEach(() => {
    // Every test loads a deck over the (stubbed) network; tests override with installFetch.
    installFetch(deckOnlyHandler(baseDeck()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.print = originalPrint;
    Reflect.deleteProperty(URL, 'createObjectURL');
  });

  it('adds a blank slide: duplicate POST, then a PUT that clears only the new copy', async () => {
    const deck = baseDeck();
    const duplicated = duplicatedDeck();
    const saved: TestDeck = {
      ...duplicated,
      revision: 5,
      content: { slides: duplicated.content.slides.map((s) => (s.id === 's4' ? { ...s, title: '', body: '', notes: '' } : s)) },
    };
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/api/workspace/slides/duplicate')) return json({ artifact: duplicated });
      if (url.includes('/api/workspace/slides/file') && method(init) === 'PUT') return json({ saved: true, revision: 5, bytes: 123, artifact: saved });
      return deckOnlyHandler(deck)(url, init);
    });
    render(<Editor {...propsFor()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add slide' }));

    await waitFor(() => expect(callsTo(fetchMock, '/api/workspace/slides/duplicate', 'POST')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/api/workspace/slides/duplicate', 'POST')[0]!)).toMatchObject({ taskId: 'task_1', index: 0, expectedRevision: 4 });

    const puts = callsTo(fetchMock, '/api/workspace/slides/file', 'PUT');
    await waitFor(() => expect(puts).toHaveLength(1));
    const payload = bodyOf(puts[0]!);
    expect(payload.expectedRevision).toBe(4);
    const slides = (payload.artifact as TestDeck).content.slides;
    expect(slides).toHaveLength(4);
    expect(slides[1]).toMatchObject({ id: 's4', title: '', body: '', notes: '', background: '#FFFFFF', accent: '#386bca' });
    expect(slides[0]).toMatchObject({ id: 's1', title: 'Alpha One', body: 'First body' });

    // The blank copy is selected for editing once the save lands.
    await waitFor(() => expect(screen.getByPlaceholderText('Slide title')).toHaveValue(''));
    expect(screen.getByPlaceholderText('Slide body')).toHaveValue('');
    expect(screen.getByPlaceholderText('Speaker notes')).toHaveValue('');
  });

  it('adopts the 409 artifact and retries the add-slide PUT once', async () => {
    const deck = baseDeck();
    const duplicated = duplicatedDeck();
    const drifted: TestDeck = { ...deck, revision: 6, content: { slides: deck.content.slides.map((s) => ({ ...s, title: `${s.title} v2` })) } };
    let putCalls = 0;
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/api/workspace/slides/duplicate')) return json({ artifact: duplicated });
      if (url.includes('/api/workspace/slides/file') && method(init) === 'PUT') {
        putCalls += 1;
        if (putCalls === 1) return json({ error: 'revision drift', artifact: drifted }, 409);
        // No artifact in the body: the editor keeps the payload it just sent.
        return json({ saved: true, revision: 7, bytes: 99 });
      }
      return deckOnlyHandler(deck)(url, init);
    });
    render(<Editor {...propsFor()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add slide' }));

    await waitFor(() => expect(putCalls).toBe(2));
    const secondPut = callsTo(fetchMock, '/api/workspace/slides/file', 'PUT')[1]!;
    const payload = bodyOf(secondPut);
    expect(payload.expectedRevision).toBe(6);
    const slides = (payload.artifact as TestDeck).content.slides;
    // The server artifact (drifted titles) is kept, with our blank copy spliced in after slide 0.
    expect(slides).toHaveLength(4);
    expect(slides[0]).toMatchObject({ id: 's1', title: 'Alpha One v2' });
    expect(slides[1]).toMatchObject({ id: 's4', title: '', body: '', notes: '' });
    await waitFor(() => expect(screen.getByPlaceholderText('Slide title')).toHaveValue(''));
  });

  it('find jumps between matches on Enter, counts them, and highlights hits', async () => {
    const view = render(<Editor {...propsFor()} />);
    await screen.findByPlaceholderText('Slide title');

    const find = screen.getByTestId('slides-find') as HTMLInputElement;
    expect(screen.queryByTestId('slides-find-count')).toBeNull();

    fireEvent.change(find, { target: { value: 'hello' } });
    expect(screen.getByTestId('slides-find-count')).toHaveTextContent('0/2');

    fireEvent.keyDown(find, { key: 'Enter' });
    expect(screen.getByTestId('slides-find-count')).toHaveTextContent('1/2');
    // Jumped to s2 whose body contains "hello"; the hit is wrapped in <mark>.
    expect(screen.getAllByText('hello')).toHaveLength(1);
    expect(view.container.querySelectorAll('mark')).toHaveLength(1);

    fireEvent.keyDown(find, { key: 'Enter' });
    expect(screen.getByTestId('slides-find-count')).toHaveTextContent('2/2');
    // s3 matches through its notes; its body has no hit.
    expect(view.container.querySelectorAll('mark')).toHaveLength(0);

    fireEvent.keyDown(find, { key: 'Enter' }); // wraps around
    expect(screen.getByTestId('slides-find-count')).toHaveTextContent('1/2');
  });

  it('real preview falls back to the built-in render when the PNG endpoint answers 503', async () => {
    const deck = baseDeck();
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/api/workspace/slides/preview')) return json({ error: 'PowerPoint export requires Windows' }, 503);
      return deckOnlyHandler(deck)(url, init);
    });
    const view = render(<Editor {...propsFor()} />);
    await screen.findByPlaceholderText('Slide title');

    fireEvent.click(screen.getByRole('button', { name: 'Real preview' }));

    await waitFor(() => expect(callsTo(fetchMock, '/api/workspace/slides/preview')).toHaveLength(1));
    expect(String(callsTo(fetchMock, '/api/workspace/slides/preview')[0]![0])).toContain('revision=4');
    expect(String(callsTo(fetchMock, '/api/workspace/slides/preview')[0]![0])).toContain('slide=0');

    expect(await screen.findByTestId('slides-png-note')).toBeInTheDocument();
    expect(view.container.querySelector('[data-testid="slides-png"]')).toBeNull();
    // The HTML render still shows the selected slide (stage, thumb, and print page).
    expect(screen.getAllByText('Alpha One').length).toBeGreaterThan(0);
  });

  it('real preview shows the fetched PNG and caches it per (slide, revision)', async () => {
    const deck = baseDeck();
    const createObjectURL = vi.fn(() => 'blob:preview-1');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/api/workspace/slides/preview')) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
      return deckOnlyHandler(deck)(url, init);
    });
    const view = render(<Editor {...propsFor()} />);
    await screen.findByPlaceholderText('Slide title');

    fireEvent.click(screen.getByRole('button', { name: 'Real preview' }));
    const img = await screen.findByTestId('slides-png');
    expect(img).toHaveAttribute('src', 'blob:preview-1');
    expect(screen.queryByTestId('slides-png-note')).toBeNull();
    await waitFor(() => expect(callsTo(fetchMock, '/api/workspace/slides/preview')).toHaveLength(1));

    // Toggling off and back on reuses the cached blob instead of refetching.
    fireEvent.click(screen.getByRole('button', { name: 'Real preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Real preview' }));
    expect(await screen.findByTestId('slides-png')).toBeInTheDocument();
    // Selecting another slide fetches a new preview for that index.
    const thumbs = view.container.querySelectorAll('[data-testid="slides-rail"] .group > button');
    expect(thumbs).toHaveLength(3);
    fireEvent.click(thumbs[1]!);
    await waitFor(() => {
      const previewCalls = callsTo(fetchMock, '/api/workspace/slides/preview');
      expect(previewCalls).toHaveLength(2);
      expect(String(previewCalls[1]![0])).toContain('slide=1');
    });
  });

  it('word count reports the current slide and the whole deck', async () => {
    render(<Editor {...propsFor()} />);
    await screen.findByPlaceholderText('Slide title');
    const counter = screen.getByTestId('slides-word-count');
    expect(counter).toHaveTextContent('Slide words: 4');
    expect(counter).toHaveTextContent('Deck words: 13');
  });

  it('printing opens one page per slide and calls window.print', async () => {
    const printMock = vi.fn();
    window.print = printMock;
    const view = render(<Editor {...propsFor()} />);
    await screen.findByPlaceholderText('Slide title');
    expect(view.container.querySelectorAll('.slides-print-page')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(printMock).toHaveBeenCalledOnce();
  });

  it('save persists through the structured PUT only (no raw fetch, no onSave blob)', async () => {
    const onSave = vi.fn(async () => {});
    const deck = baseDeck();
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/api/workspace/slides/file') && method(init) === 'PUT') return json({ saved: true, revision: 5, bytes: 10, artifact: { ...deck, revision: 5 } });
      return deckOnlyHandler(deck)(url, init);
    });
    render(<Editor {...propsFor({ onSave })} />);
    await screen.findByPlaceholderText('Slide title');

    fireEvent.change(screen.getByPlaceholderText('Slide title'), { target: { value: 'Alpha One edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(callsTo(fetchMock, '/api/workspace/slides/file', 'PUT')).toHaveLength(1));
    // The old &raw=1 blob refetch (and the onSave(blob) handoff) is gone: the PUT already persisted.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('raw=1'))).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});
