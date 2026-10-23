/**
 * Neo N18: the canvas panel, driven the way a user drives it.
 *
 * Playwright is unavailable here, so the acceptance flow is asserted through the
 * DOM: tag a node, drop a note, search a title, read the side rail, pan from the
 * minimap. Both the graph and the annotation layer are injected, which is exactly
 * what the panel is built for, so the same code path runs with no network.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasAnnotationsClient } from '../annotationsClient';
import { CanvasPanel, type CanvasPanelProps } from '../CanvasPanel';
import { CanvasClient } from '../client';
import { CanvasStream } from '../stream';
import type { CanvasGraphResponse, CanvasLayoutNode } from '../types';
import { emptyCanvasAnnotations } from '../types.annotations';

const RUN = 'task_canvas_n18';

/** A two-node run: a root step and a document that cites it. */
function twoNodeGraph(): CanvasGraphResponse {
  const nodes: CanvasLayoutNode[] = [
    {
      id: 'n1',
      run_id: RUN,
      parent_ids: [],
      type: 'recipe_step',
      status: 'running',
      data: { title: 'Gather quarterly sources', stepId: 's1' },
      position: 0,
      version: 1,
      created: 1,
      updated: 1,
      x: 40,
      y: 40,
      depth: 0,
    },
    {
      id: 'n2',
      run_id: RUN,
      parent_ids: ['n1'],
      type: 'document',
      status: 'finished',
      data: { title: 'Draft the quarterly report', path: 'report.md' },
      position: 1,
      version: 1,
      created: 2,
      updated: 3,
      x: 40,
      y: 240,
      depth: 1,
    },
  ];
  return {
    runId: RUN,
    enabled: true,
    nodes,
    edges: [{ from: 'n1', to: 'n2' }],
    stats: {
      totalNodes: nodes.length,
      nodesByType: { recipe_step: 1, document: 1 },
      nodesByStatus: { running: 1, finished: 1 },
      depth: 1,
      edges: 1,
    },
    fresh: [],
  };
}

/** A stream stub that never reaches a server, so no timer leaks between tests. */
function idleStream(): CanvasStream {
  let running = false;
  return {
    start: vi.fn(async () => {
      running = true;
    }),
    stop: vi.fn(() => {
      running = false;
    }),
    isRunning: () => running,
  } as unknown as CanvasStream;
}

/**
 * A fake annotation server that starts empty and records the edits the panel
 * sends. It is a plain object because the panel only needs the client's methods.
 *
 * `getAnnotations` returns a copy, the way a real client parses a fresh response:
 * the panel appends what the server returns to the layer it already holds, so a
 * shared array would be counted twice.
 */
function fakeAnnotationServer(annotations = emptyCanvasAnnotations(RUN)) {
  const client = {
    getAnnotations: vi.fn(async () => ({
      ...annotations,
      tags: { ...annotations.tags },
      comments: { ...annotations.comments },
      notes: annotations.notes.map((note) => ({ ...note })),
    })),
    setColour: vi.fn(async (runId: string, nodeId: string, patch: { colour: string }) => {
      if (patch.colour === 'none') delete annotations.tags[nodeId];
      else annotations.tags[nodeId] = patch.colour as never;
    }),
    addComment: vi.fn(async (runId: string, nodeId: string, draft: { text: string }) => {
      const comment = { id: `c${nextId()}`, author: 'user', text: draft.text, created: 1 };
      annotations.comments[nodeId] = [...(annotations.comments[nodeId] ?? []), comment];
      return comment;
    }),
    removeComment: vi.fn(async (runId: string, nodeId: string, commentId: string) => {
      annotations.comments[nodeId] = (annotations.comments[nodeId] ?? []).filter((entry) => entry.id !== commentId);
    }),
    addNote: vi.fn(async (runId: string, draft: { text: string; x: number; y: number }) => {
      const note = { id: `note-${nextId()}`, colour: 'none' as const, created: 1, updated: 1, ...draft };
      annotations.notes = [...annotations.notes, note];
      return note;
    }),
    updateNote: vi.fn(async (runId: string, noteId: string, patch: { text?: string; x?: number; y?: number }) => {
      const note = annotations.notes.find((entry) => entry.id === noteId);
      return note ? { ...note, ...patch } : undefined;
    }),
    removeNote: vi.fn(async (runId: string, noteId: string) => {
      annotations.notes = annotations.notes.filter((entry) => entry.id !== noteId);
    }),
  };
  return { client: client as unknown as CanvasAnnotationsClient, annotations };
}

/**
 * The node cards in graph order, for the tests that target one of them. The panel
 * loads the graph asynchronously, so this waits for the cards before returning.
 */
async function nodeCards(): Promise<HTMLElement[]> {
  return screen.findAllByTestId('canvas-node');
}

/** A counter for fake ids, so a second note or comment never reuses the first's. */
let idCounter = 0;
const nextId = (): number => {
  idCounter += 1;
  return idCounter;
};

function renderPanel(overrides: Partial<CanvasPanelProps> = {}) {
  const getGraph = vi.fn(async () => twoNodeGraph());
  const client = { getGraph, patchNode: vi.fn() } as unknown as CanvasClient;
  render(
    <CanvasPanel taskId={RUN} live={false} client={client} stream={idleStream()} events={[]} {...overrides} />,
  );
  return { getGraph };
}

describe('CanvasPanel (N18)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('tags a node and paints the card with the colour it chose', async () => {
    const { client, annotations } = fakeAnnotationServer();
    renderPanel({ annotationsClient: client });

    const card = (await nodeCards())[0]!;
    expect(card).toHaveAttribute('data-node-id', 'n1');
    expect(card).toHaveAttribute('data-node-tag', 'none');

    fireEvent.click(within(card).getByTestId('canvas-node-tag-blue'));
    await waitFor(() => expect(card).toHaveAttribute('data-node-tag', 'blue'));
    expect(annotations.tags.n1).toBe('blue');
    // The panel tells the server once the swatch is clicked, with the same colour.
    expect(client.setColour).toHaveBeenCalledWith(RUN, 'n1', { colour: 'blue' });
  });

  it('clears a tag back to none from the same swatch row', async () => {
    const annotations = emptyCanvasAnnotations(RUN);
    annotations.tags = { n1: 'green' };
    const { client } = fakeAnnotationServer(annotations);
    renderPanel({ annotationsClient: client });

    const card = (await nodeCards())[0]!;
    expect(card).toHaveAttribute('data-node-tag', 'green');
    fireEvent.click(within(card).getByTestId('canvas-node-tag-none'));
    await waitFor(() => expect(card).toHaveAttribute('data-node-tag', 'none'));
  });

  it('drops a note, keeps it editable, and saves it when the caret leaves', async () => {
    const { client } = fakeAnnotationServer();
    renderPanel({ annotationsClient: client });

    fireEvent.click(await screen.findByTestId('canvas-add-note'));
    const note = await screen.findByTestId('canvas-note');
    const noteId = note.getAttribute('data-note-id')!;
    // The note opens editable, so the user can type into it straight away.
    expect(note).toHaveAttribute('data-note-editing', 'true');

    fireEvent.change(screen.getByTestId('canvas-note-text'), { target: { value: 'Remember the deadline' } });
    fireEvent.blur(screen.getByTestId('canvas-note-text'));

    await waitFor(() => expect(client.addNote).toHaveBeenCalledWith(RUN, { text: 'New note', x: 120, y: 120 }));
    await waitFor(() =>
      expect(client.updateNote).toHaveBeenCalledWith(RUN, noteId, { text: 'Remember the deadline' }),
    );
    // The rail lists the note, so it is not invisible once it leaves the surface.
    expect(await screen.findByTestId('canvas-notes-item')).toHaveAttribute('data-note-id', noteId);
  });

  it('deletes a note the run already has', async () => {
    const annotations = emptyCanvasAnnotations(RUN);
    annotations.notes = [{ id: 'note-9', text: 'Stale', x: 10, y: 10, colour: 'red', created: 1, updated: 1 }];
    const { client } = fakeAnnotationServer(annotations);
    renderPanel({ annotationsClient: client });

    expect(await screen.findByTestId('canvas-note')).toHaveAttribute('data-note-id', 'note-9');
    fireEvent.click(screen.getByTestId('canvas-note-delete'));
    await waitFor(() => expect(client.removeNote).toHaveBeenCalledWith(RUN, 'note-9'));
    await waitFor(() => expect(screen.queryByTestId('canvas-note')).not.toBeInTheDocument());
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
  });

  it('adds a comment from the node thread and counts it on the card', async () => {
    const { client } = fakeAnnotationServer();
    renderPanel({ annotationsClient: client });

    const card = (await nodeCards())[0]!;
    fireEvent.click(card);
    const thread = await screen.findByTestId('canvas-comments');
    expect(within(thread).getByText('No comments yet.')).toBeInTheDocument();

    fireEvent.change(within(thread).getByTestId('canvas-comment-input'), { target: { value: 'Looks good' } });
    fireEvent.click(within(thread).getByTestId('canvas-comment-submit'));

    await waitFor(() => expect(within(thread).getByText('Looks good')).toBeInTheDocument());
    await waitFor(() => expect(within(card).getByTestId('canvas-node-comment-count')).toHaveTextContent('1'));
    expect(client.addComment).toHaveBeenCalledWith(RUN, 'n1', { text: 'Looks good' });
  });

  it('searches the nodes it holds and lists the hits in the rail', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');

    fireEvent.change(screen.getByTestId('canvas-search'), { target: { value: 'quarterly' } });

    const results = await screen.findByTestId('canvas-search-results');
    expect(within(results).getByText('2 matches')).toBeInTheDocument();
    expect(within(results).getAllByTestId('canvas-search-hit')).toHaveLength(2);
    // Both matching cards carry the highlight ring the search drives.
    expect((await nodeCards()).every((node) => node.getAttribute('data-node-match') === 'true')).toBe(true);
    // The minimap draws the same matches, so the thumbnail and the cards agree.
    expect(
      screen.getAllByTestId('canvas-minimap-node').every((dot) => dot.getAttribute('data-node-match') === 'true'),
    ).toBe(true);
  });

  it('narrows a search as the term grows and reports when nothing matches', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');

    const search = screen.getByTestId('canvas-search');
    fireEvent.change(search, { target: { value: 'quarterly report' } });
    expect(screen.getByTestId('canvas-search-results')).toHaveTextContent('1 matches');
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No matches on this canvas.')).toBeInTheDocument();
  });

  it('opens the shortcut sheet and closes it with Escape', async () => {
    renderPanel();
    // The toolbar is part of the loaded graph, so it waits with the rest.
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getByTestId('canvas-shortcuts-toggle'));
    const sheet = await screen.findByTestId('canvas-shortcuts');
    expect(sheet).toHaveTextContent('Add a note');
    expect(sheet).toHaveTextContent('Search the canvas');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('canvas-shortcuts')).not.toBeInTheDocument();
  });

  it('pans the canvas from a click on the minimap', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');
    const before = (screen.getByTestId('canvas-surface').firstChild as HTMLElement).style.transform;

    fireEvent.click(screen.getByTestId('canvas-minimap'));
    await waitFor(() => {
      const after = (screen.getByTestId('canvas-surface').firstChild as HTMLElement).style.transform;
      expect(after).not.toBe(before);
    });
  });

  it('focuses the search box with the S shortcut without stealing typed text', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.keyDown(window, { key: 's' });
    // The shortcut focuses the box rather than typing into it.
    expect(screen.getByTestId('canvas-search')).toHaveFocus();
    // A keystroke aimed at the search box is text, not a shortcut.
    fireEvent.keyDown(screen.getByTestId('canvas-search'), { key: 'n' });
    expect(screen.queryByTestId('canvas-note')).not.toBeInTheDocument();
  });

  it('shows a server failure as a notice rather than a crash', async () => {
    const annotations = emptyCanvasAnnotations(RUN);
    const client = {
      getAnnotations: vi.fn(async () => annotations),
      setColour: vi.fn(async () => {
        throw new Error('annotation store unreachable');
      }),
      addComment: vi.fn(),
      removeComment: vi.fn(),
      addNote: vi.fn(),
      updateNote: vi.fn(),
      removeNote: vi.fn(),
    } as unknown as CanvasAnnotationsClient;
    renderPanel({ annotationsClient: client });

    const card = (await nodeCards())[0]!;
    fireEvent.click(within(card).getByTestId('canvas-node-tag-red'));
    await waitFor(() => expect(screen.getByTestId('canvas-error')).toHaveTextContent('annotation store unreachable'));
  });
});
