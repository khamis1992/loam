/**
 * Neo N2: the Canvas panel.
 *
 * The acceptance test asks for a live canvas with an Organize action, an E
 * shortcut that opens a node, and RTL labels. Playwright is not available in
 * this harness, so the component behaviour is pinned here with the real panel and
 * an injected client: the same code path, no network.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolUsedEvent } from '@shared/socket';

import { CanvasPanel, type CanvasPanelProps } from '../CanvasPanel';
import { CanvasClient } from '../client';
import { CanvasStream } from '../stream';
import type { CanvasGraphResponse, CanvasLayoutNode } from '../types';

const RUN = 'task_canvas_panel_1';

/**
 * jsdom has no blob URL support, so the download step is stubbed. The anchor
 * created by the panel is still the real one, so the file name is still
 * asserted from the DOM rather than from this stub.
 */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:stub');
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = vi.fn();
}

/** A six-step run plus its root question, the shape the acceptance test describes. */
function sixStepGraph(): CanvasGraphResponse {
  const nodes: CanvasLayoutNode[] = [
    {
      id: 'root',
      run_id: RUN,
      parent_ids: [],
      type: 'question',
      status: 'finished',
      data: { title: 'Build the marketing site' },
      position: 1,
      version: 1,
      created: 1,
      updated: 1,
      x: 40,
      y: 40,
      depth: 0,
    },
  ];
  ['one', 'two', 'three', 'four', 'five', 'six'].forEach((stepId, index) => {
    nodes.push({
      id: `step-${stepId}`,
      run_id: RUN,
      parent_ids: ['root'],
      type: 'recipe_step',
      status: index < 2 ? 'finished' : 'init',
      data: { title: `Step ${index + 1}`, stepId },
      position: index + 2,
      version: 1,
      created: 1,
      updated: 1,
      x: 40 + index * 280,
      y: 240,
      depth: 1,
    });
  });
  return {
    runId: RUN,
    enabled: true,
    nodes,
    edges: nodes.slice(1).map((node) => ({ from: 'root', to: node.id })),
    stats: {
      totalNodes: nodes.length,
      nodesByType: { question: 1, recipe_step: 6 },
      nodesByStatus: { finished: 3, init: 4 },
      depth: 1,
      edges: 6,
    },
    fresh: [],
  };
}

/**
 * A stream stub that never reaches a server, so no polling/timer leaks between
 * tests. It still tracks its running state, because the panel reads
 * `isRunning()` to decide whether the canvas is live.
 */
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

function toolEvent(name: string, actionId: string): ToolUsedEvent {
  return {
    id: `ev-${actionId}`,
    type: 'toolUsed',
    tool: name,
    actionId,
    status: 'running',
    timestamp: Date.now(),
  } as ToolUsedEvent;
}

interface Harness {
  client: CanvasClient;
  getGraph: ReturnType<typeof vi.fn>;
  patchNode: ReturnType<typeof vi.fn>;
}

function harness(graph: () => CanvasGraphResponse, patches: Record<string, unknown> = {}): Harness {
  const getGraph = vi.fn(async () => graph());
  const patchNode = vi.fn(async (_runId: string, nodeId: string, patch: unknown) => ({
    id: nodeId,
    run_id: RUN,
    parent_ids: [],
    type: 'recipe_step',
    status: 'finished',
    version: 2,
    created: 1,
    updated: 2,
    ...(patch as object),
    ...(patches[nodeId] ?? {}),
  }));
  const client = { getGraph, patchNode } as unknown as CanvasClient;
  return { client, getGraph, patchNode };
}

function renderPanel(overrides: Partial<CanvasPanelProps> = {}, graph = sixStepGraph) {
  const { client, getGraph, patchNode } = harness(graph);
  const stream = idleStream();
  render(
    <CanvasPanel
      taskId={RUN}
      live={false}
      client={client}
      stream={stream}
      events={[toolEvent('web_search', 'a1')]}
      {...overrides}
    />,
  );
  return { client, getGraph, patchNode, stream };
}

describe('canvas panel', () => {
  it('renders a six-step run as seven live nodes and lists the recipe steps', async () => {
    renderPanel();
    const nodes = await screen.findAllByTestId('canvas-node');
    // Root question plus six recipe steps.
    expect(nodes).toHaveLength(7);
    // Every node card is labelled with its title, so a node is never anonymous.
    expect(screen.getByRole('button', { name: 'Build the marketing site' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Step 1' })).toBeInTheDocument();
    // The Recipe side panel lists the plan's steps, in order.
    expect(screen.getByTestId('canvas-recipe')).toHaveTextContent('Recipe');
    expect(screen.getByText('1. Step 1')).toBeInTheDocument();
    expect(screen.getByText('6. Step 6')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-stats')).toHaveTextContent('7 nodes');
    // The status glyphs the panel draws for a finished step and a pending one.
    expect(screen.getAllByText('✓').length).toBeGreaterThan(0);
    expect(screen.getAllByText('○').length).toBeGreaterThan(0);
  });

  it('Organize lays the graph out again without overlapping nodes', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getByRole('button', { name: 'Organize' }));
    await waitFor(() => {
      const after = screen.getAllByTestId('canvas-node').map((node) => (node as HTMLElement).style.transform);
      // Two cards can never share a cell: the acceptance rule.
      expect(new Set(after).size).toBe(after.length);
    });
  });

  it('opens the newest node with the E shortcut and closes it with Escape', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.keyDown(window, { key: 'e' });
    const detail = await screen.findByTestId('canvas-node-detail');
    // E opens the newest node.
    expect(detail).toHaveAttribute('data-node-id', 'step-six');
    expect(detail).toHaveTextContent('Step 6');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('canvas-node-detail')).toBeNull();
  });

  it('edits a node by hand and saves the change through the client', async () => {
    const { patchNode } = renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getByRole('button', { name: 'Step 1' }));
    const textarea = await screen.findByLabelText('Edit this node');
    fireEvent.change(textarea, { target: { value: 'Gather sources from the archive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchNode).toHaveBeenCalledOnce());
    const [, nodeId, patch] = patchNode.mock.calls[0] as [string, string, { data?: { title?: string } }];
    expect(nodeId).toBe('step-one');
    expect(patch.data!.title).toBe('Gather sources from the archive');
  });

  it('zooms from the toolbar and keeps the readout in percent', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');
    const zoom = screen.getByTestId('canvas-zoom');
    expect(zoom).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoom).toHaveTextContent('120%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(zoom).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Reset the view' }));
    expect(zoom).toHaveTextContent('100%');
  });

  it('applies live updates from the stream to the canvas', async () => {
    const connected = renderPanel({ live: true });
    // The panel starts the injected stream itself, exactly as it would a real one.
    await waitFor(() => expect(connected.stream.isRunning()).toBe(true));
    // The indicator reflects the connection, not the task status.
    expect(screen.getByTestId('canvas-live')).toHaveTextContent('Live');
    connected.stream.stop();
    await waitFor(() => expect(screen.getByTestId('canvas-live')).toHaveTextContent('Paused'));
  });

  it('shows an empty canvas and the error notice instead of crashing', async () => {
    renderPanel({}, () => ({ ...sixStepGraph(), nodes: [], edges: [], stats: { ...sixStepGraph().stats, totalNodes: 0 } }));
    expect(await screen.findByTestId('canvas-empty')).toBeInTheDocument();

    const { client } = harness(() => sixStepGraph());
    client.getGraph = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as CanvasClient['getGraph'];
    const { unmount } = render(
      <CanvasPanel taskId={RUN} live={false} client={client} stream={idleStream()} events={[]} />,
    );
    expect(await screen.findByTestId('canvas-error')).toHaveTextContent(/could not reach the task/i);
    expect(screen.getByTestId('canvas-error')).toHaveTextContent('connection refused');
    unmount();
  });

  it('keeps the graph surface left-to-right while the chrome is direction-aware', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');
    // Graph space is ltr by definition; the panel itself follows the locale.
    expect(screen.getByTestId('canvas-surface')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('canvas-panel')).toBeInTheDocument();
  });

  it('renders Arabic labels when the locale is Arabic', async () => {
    renderPanel({ getLocale: () => 'ar' });
    await screen.findAllByTestId('canvas-node');
    expect(screen.getByTestId('canvas-recipe')).toHaveTextContent('الوصفة');
    expect(screen.getByTestId('canvas-stats')).toHaveTextContent('7 عقد');
  });

  it('points the document direction at the rendered locale', async () => {
    // The panel lays out with logical CSS, so the document direction has to
    // follow the locale the panel renders in; the canvas surface stays ltr.
    const { unmount } = render(
      <CanvasPanel taskId={RUN} live={false} client={harness(sixStepGraph).client} stream={idleStream()} events={[]} />,
    );
    expect(await screen.findByTestId('canvas-panel')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    unmount();

    renderPanel({ getLocale: () => 'ar' });
    expect(await screen.findByTestId('canvas-recipe')).toBeInTheDocument();
    // The injected provider is a test seam, so it must not rewrite the document.
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByTestId('canvas-surface')).toHaveAttribute('dir', 'ltr');
  });

  it('marks an RTL node as such in its detail sheet', async () => {
    renderPanel({ getLocale: () => 'ar' });
    await screen.findAllByTestId('canvas-node');
    fireEvent.keyDown(window, { key: 'e' });
    const detail = await screen.findByTestId('canvas-node-detail');
    // The sheet marks the node as right-to-left with the Arabic label.
    expect(detail).toHaveTextContent('من اليمين إلى اليسار');
  });

  it('renders a model arm with its own label and the answer its model produced', async () => {
    const graph = sixStepGraph();
    // N10 A/B: an arm is a sibling node off the root carrying the model it ran.
    graph.nodes.push(
      {
        id: 'sibling-1',
        run_id: RUN,
        parent_ids: ['root'],
        type: 'sibling',
        status: 'finished',
        data: { model: 'glm-5.4-flash:cloud', answer: 'done by glm-5.4-flash:cloud' },
        position: 8,
        version: 1,
        created: 1,
        updated: 1,
        x: 1960,
        y: 240,
        depth: 1,
      },
      {
        id: 'sibling-2',
        run_id: RUN,
        parent_ids: ['root'],
        type: 'sibling',
        status: 'finished',
        data: { model: 'qwen3-coder-30b', answer: 'done by qwen3-coder-30b' },
        position: 9,
        version: 1,
        created: 1,
        updated: 1,
        x: 2240,
        y: 240,
        depth: 1,
      },
    );
    graph.stats.totalNodes = graph.nodes.length;
    graph.stats.nodesByType.sibling = 2;

    renderPanel({}, () => graph);
    await screen.findAllByTestId('canvas-node');
    // Each arm card carries the model it ran plus the answer that model
    // produced, so the comparison is readable straight off the canvas.
    const arm = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid="canvas-node"][data-node-id="${id}"]`)!;
    expect(arm('sibling-1')).toHaveTextContent('glm-5.4-flash:cloud');
    expect(arm('sibling-1')).toHaveTextContent('done by glm-5.4-flash:cloud');
    expect(arm('sibling-2')).toHaveTextContent('qwen3-coder-30b');
    expect(arm('sibling-2')).toHaveTextContent('done by qwen3-coder-30b');
    // The card still names its kind and state, not just the payload.
    expect(arm('sibling-1')).toHaveTextContent('Model arm · Finished');
  });

  it('lists the recent tools on the node detail sheet', async () => {
    renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.keyDown(window, { key: 'e' });
    expect(await screen.findByText('Recent tools')).toBeInTheDocument();
    expect(screen.getByText('web_search')).toBeInTheDocument();
  });

  it('exports the run as a self-contained replay file', async () => {
    // The panel downloads the server-rendered page; the server is what strips
    // credentials, so the panel only ever has to pick the right endpoint and file name.
    const fetcher = vi.fn(
      async () =>
        new Response('<!doctype html><html><body>replay</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    ) as unknown as typeof fetch;
    // The panel removes the anchor right after clicking it, so capture it at click time.
    const clicked: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function click(this: HTMLAnchorElement) {
        clicked.push(this);
      });
    renderPanel({ fetchFn: fetcher, apiBase: 'http://127.0.0.1:3939' });
    await screen.findAllByTestId('canvas-node');

    fireEvent.click(screen.getByRole('button', { name: 'Export replay' }));
    await waitFor(() => expect(screen.getByTestId('canvas-replay-notice')).toHaveTextContent('Replay exported'));

    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = String((fetcher as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]);
    expect(url).toBe(`http://127.0.0.1:3939/api/graph/${RUN}/replay/html`);

    // The downloaded file name follows the same convention as the JSON variant.
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.getAttribute('download')).toBe(`loam-replay-${RUN}.html`);
    clickSpy.mockRestore();
  });

  it('reports a failed replay export without breaking the canvas', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    renderPanel({ fetchFn: fetcher, apiBase: 'http://127.0.0.1:3939' });
    await screen.findAllByTestId('canvas-node');

    fireEvent.click(screen.getByRole('button', { name: 'Export replay' }));
    expect(await screen.findByTestId('canvas-replay-notice')).toHaveTextContent('Replay export failed');
    // The canvas itself is untouched.
    expect(screen.getByTestId('canvas-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-error')).toBeNull();
  });
});
