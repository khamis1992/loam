/**
 * Neo N14: the replay viewer.
 *
 * The acceptance test asks for: export -> open file offline -> scrub shows nodes
 * appearing in order, and the secret scan finds 0 tokens. Playwright is not
 * available in this harness, so the component behaviour is pinned here with the
 * real component and an injected fetch: the same code path, no network. The
 * offline-file half of that sentence is covered by the server-side test of the
 * generated HTML (src/graph/__tests__/export.test.ts).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReplayViewer, type RunReplay } from '../ReplayViewer';

const RUN = 'task_replay_viewer_1';

/** A three-node run: root question -> search -> document. */
function threeNodeReplay(): RunReplay {
  return {
    format: 1,
    runId: RUN,
    title: 'Publish the quarterly report',
    createdAt: '2026-01-01T00:00:00.000Z',
    generatedAt: '2026-01-01T00:01:00.000Z',
    nodes: [
      { id: 'root', parent_ids: [], type: 'question', status: 'finished', data: { title: 'Publish the report' }, position: 1, created: 1, updated: 1 },
      { id: 'search', parent_ids: ['root'], type: 'search', status: 'finished', data: { tool: 'web_search', query: 'revenue' }, position: 2, created: 2, updated: 2 },
      { id: 'doc', parent_ids: ['search'], type: 'document', status: 'finished', data: { path: 'report.md', kind: 'document', mime: 'text/markdown', sizeBytes: 12 }, position: 3, created: 3, updated: 3 },
    ],
    edges: [
      { from: 'root', to: 'search' },
      { from: 'search', to: 'doc' },
    ],
    frames: [
      { index: 0, nodeId: 'root', at: 1, type: 'question', status: 'finished', label: 'Publish the report' },
      { index: 1, nodeId: 'search', at: 2, type: 'search', status: 'finished', label: 'revenue' },
      { index: 2, nodeId: 'doc', at: 3, type: 'document', status: 'finished', label: 'report.md' },
    ],
    outputs: [{ path: 'report.md', title: 'report.md', kind: 'document', mime: 'text/markdown', sizeBytes: 12 }],
    stats: {
      totalNodes: 3,
      nodesByType: { question: 1, search: 1, document: 1 },
      nodesByStatus: { finished: 3 },
      edges: 2,
      depth: 2,
      durationMs: 2000,
    },
    redactions: 1,
    partial: false,
  };
}

function stubFetch(replay: RunReplay): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(replay), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe('ReplayViewer', () => {
  it('loads the bundle from the run replay endpoint', async () => {
    const fetcher = stubFetch(threeNodeReplay());
    render(<ReplayViewer runId={RUN} fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId('replay-viewer')).toBeTruthy());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = String((fetcher as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]);
    expect(url).toContain(`/api/graph/${RUN}/replay`);
  });

  it('scrubbing reveals nodes in order, and the whole run is shown at the end', async () => {
    render(<ReplayViewer runId={RUN} fetcher={stubFetch(threeNodeReplay())} />);
    const scrubber = (await screen.findByTestId('replay-scrubber')) as HTMLInputElement;
    const frames = () => screen.getAllByTestId('replay-frame');
    const revealed = () => frames().filter((f) => f.dataset.revealed === 'true').length;

    // The viewer opens on the last frame, so every node is visible.
    expect(scrubber.value).toBe('2');
    expect(revealed()).toBe(3);

    fireEvent.change(scrubber, { target: { value: '0' } });
    // Frame 0 reveals only the root.
    expect(revealed()).toBe(1);

    fireEvent.change(scrubber, { target: { value: '1' } });
    // Frame 1 reveals root and search, in order.
    expect(revealed()).toBe(2);

    fireEvent.change(scrubber, { target: { value: '2' } });
    expect(revealed()).toBe(3);

    // The revealed set is always a prefix: the order the agent emitted nodes in.
    expect(frames()[0]!.dataset.node).toBe('root');
    expect(frames()[1]!.dataset.node).toBe('search');
    expect(frames()[2]!.dataset.node).toBe('doc');
  });

  it('shows the produced files and the view-only frame', async () => {
    render(<ReplayViewer runId={RUN} fetcher={stubFetch(threeNodeReplay())} />);
    await screen.findByTestId('replay-viewer');

    // The graph and the timeline are both present, and the run produced report.md.
    expect(screen.getByTestId('replay-graph')).toBeTruthy();
    expect(screen.getByTestId('replay-timeline')).toBeTruthy();
    expect(screen.getByTestId('replay-outputs').textContent).toContain('report.md');
    // A scrubber, play/pause and reset: the viewer is read-only otherwise.
    expect(screen.getByRole('slider')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('reports a failed export instead of an empty viewer', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    render(<ReplayViewer runId={RUN} fetcher={fetcher} />);
    expect(await screen.findByTestId('replay-error')).toBeTruthy();
    expect(screen.queryByTestId('replay-viewer')).toBeNull();
  });
});
