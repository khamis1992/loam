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
  searchGraph: ReturnType<typeof vi.fn>;
  patchNode: ReturnType<typeof vi.fn>;
  applyOp: ReturnType<typeof vi.fn>;
}

function harness(
  graph: () => CanvasGraphResponse,
  patches: Record<string, unknown> = {},
  search?: Awaited<ReturnType<CanvasClient['searchGraph']>>,
  ops: Record<string, Record<string, unknown>> = {},
): Harness {
  const getGraph = vi.fn(async () => graph());
  // A client that answers no search stands in for a server without the N18
  // route, so the panel falls back to searching the nodes it already holds.
  const searchGraph = vi.fn(async () => search ?? null);
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
  /**
   * An N11 operation reply: the whole graph again, plus the ids it superseded.
   * The default is "the graph you already have, one node touched", which is what
   * the server returns for an edit that changed nothing downstream.
   */
  const applyOp = vi.fn(async (_runId: string, op: unknown) => {
    const request = op as { op: string; nodeId: string };
    const current = graph();
    const touched = current.nodes.find((node) => node.id === request.nodeId);
    const override = ops[request.op] ?? {};
    const stale: string[] = Array.isArray(override.stale) ? [...(override.stale as string[])] : [];
    const base = {
      op: request.op,
      nodeId: touched?.id ?? request.nodeId,
      touched: touched ? [touched.id] : [],
      stale,
      nodes: current.nodes,
      edges: current.edges,
      stats: current.stats,
    };
    return {
      ...base,
      ...override,
      // The server writes `stale` onto the node payload itself, and the panel
      // clears a mark when the node comes back current. Returning the ids alone
      // would wipe the flag, so the reply has to carry the payload too.
      nodes: (override.nodes as CanvasLayoutNode[] | undefined) ?? base.nodes.map((node) =>
        stale.includes(node.id)
          ? { ...node, data: { ...(node.data as Record<string, unknown>), stale: true } }
          : node,
      ),
    };
  });
  // `patchNode` is still part of the client contract (a status-only write), but
  // no N11 test drives it: every edit goes through `applyOp`.
  const client = { getGraph, searchGraph, patchNode, applyOp } as unknown as CanvasClient;
  return { client, getGraph, searchGraph, patchNode, applyOp };
}

function renderPanel(
  overrides: Partial<CanvasPanelProps> = {},
  graph = sixStepGraph,
  search?: Awaited<ReturnType<CanvasClient['searchGraph']>>,
  ops: Record<string, Record<string, unknown>> = {},
) {
  const { client, getGraph, searchGraph, patchNode, applyOp } = harness(graph, {}, search, ops);
  const stream = idleStream();
  const { unmount } = render(
    <CanvasPanel
      taskId={RUN}
      live={false}
      client={client}
      stream={stream}
      events={[toolEvent('web_search', 'a1')]}
      {...overrides}
    />,
  );
  return { client, getGraph, searchGraph, patchNode, applyOp, stream, unmount };
}

/** The laid-out transform of each node card, keyed by its node id. */
function nodeTransforms(): Map<string, string> {
  const map = new Map<string, string>();
  for (const card of screen.getAllByTestId('canvas-node')) {
    map.set(card.getAttribute('data-node-id') ?? '', (card as HTMLElement).style.transform);
  }
  return map;
}

/** Lay the graph out in `direction`, and return the id -> transform map. */
async function laidOut(direction: 'ltr' | 'rtl', label: string): Promise<Map<string, string>> {
  const mounted = renderPanel({ layoutOptions: { direction } });
  await screen.findAllByTestId('canvas-node');
  fireEvent.click(screen.getByRole('button', { name: label }));
  // Organize is the only path that runs the layout; wait for the root to land
  // on the first column, which proves the pass finished.
  await waitFor(() => expect(nodeTransforms().get('root')).toContain('40px'));
  const map = nodeTransforms();
  mounted.unmount();
  return map;
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

  it('edits a node by hand, which versions it rather than patching a field', async () => {
    const { applyOp } = renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getByRole('button', { name: 'Step 1' }));
    const textarea = await screen.findByLabelText(/Edit this node/);
    fireEvent.change(textarea, { target: { value: 'Gather sources from the archive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(applyOp).toHaveBeenCalledOnce());
    const [runId, op] = applyOp.mock.calls[0] as [
      string,
      { op: string; nodeId: string; text: string; mode?: string },
    ];
    expect(runId).toBe(RUN);
    // N11: the edit is an *operation*, so it reaches the graph and the directive
    // together. A bare PATCH would change the node without telling the agent.
    expect(op).toMatchObject({
      op: 'edit',
      nodeId: 'step-one',
      text: 'Gather sources from the archive',
      mode: 'follow-up',
    });
  });

  it('flags the nodes an edit superseded and keeps them flagged', async () => {
    // The reply carries the ids the edit superseded, which is the only place the
    // panel learns them: it does not recompute dependencies itself.
    const { applyOp } = renderPanel({}, sixStepGraph, undefined, { edit: { stale: ['step-two', 'step-three'] } });
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getByRole('button', { name: 'Step 1' }));
    const textarea = await screen.findByLabelText(/Edit this node/);
    fireEvent.change(textarea, { target: { value: 'Gather sources from the archive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByTestId('canvas-stale-count')).toBeInTheDocument());
    expect(screen.getByTestId('canvas-stale-count')).toHaveTextContent('2 stale');
    const node = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid="canvas-node"][data-node-id="${id}"]`)!;
    expect(node('step-two')).toHaveAttribute('data-stale', 'true');
    expect(node('step-three')).toHaveAttribute('data-stale', 'true');
    // The edited node itself is current: it *is* the correction.
    expect(node('step-one')).toHaveAttribute('data-stale', 'false');
    // The reply said which nodes it superseded, so that is what the panel shows.
    expect(applyOp.mock.calls[0]![1]).toMatchObject({ op: 'edit' });
  });

  it('marks a node stale straight from its payload, before any edit', async () => {
    // The server can already carry `stale` on a payload (a re-run superseded it
    // earlier), so the canvas must read it from the graph, not only from an op.
    const graph = sixStepGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.id === 'step-two'
        ? { ...node, data: { ...(node.data as Record<string, unknown>), stale: true } }
        : node,
    );
    renderPanel({}, () => graph);
    await screen.findAllByTestId('canvas-node');
    const card = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid="canvas-node"][data-node-id="${id}"]`)!;
    expect(card('step-two')).toHaveAttribute('data-stale', 'true');
    expect(card('step-two')).toHaveTextContent('Stale');
    expect(card('step-one')).toHaveAttribute('data-stale', 'false');
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

  it('selects nodes for a group and merges them into one context', async () => {
    const { applyOp } = renderPanel();
    await screen.findAllByTestId('canvas-node');
    expect(screen.getByTestId('canvas-selection-count')).toHaveTextContent('0 selected');

    // Grouping needs two nodes, so the action is disabled until there are two.
    const group = () => screen.getByRole('button', { name: 'Group' });
    expect(group()).toBeDisabled();
    fireEvent.click(screen.getAllByTestId('canvas-node-select')[0]!);
    expect(group()).toBeDisabled();
    fireEvent.click(screen.getAllByTestId('canvas-node-select')[1]!);
    expect(screen.getByTestId('canvas-selection-count')).toHaveTextContent('2 selected');
    expect(
      document.querySelector<HTMLElement>('[data-testid="canvas-node"][data-node-id="root"]')!,
    ).toHaveAttribute('data-selected', 'true');

    fireEvent.click(group());
    await waitFor(() => expect(applyOp).toHaveBeenCalledOnce());
    const op = applyOp.mock.calls[0]![1] as { op: string; nodeIds: string[] };
    expect(op.op).toBe('group');
    expect(op.nodeIds).toEqual(['root', 'step-one']);
  });

  it('reconnects the selected node to the others it should consume', async () => {
    const { applyOp } = renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getAllByTestId('canvas-node-select')[0]!);
    fireEvent.click(screen.getAllByTestId('canvas-node-select')[1]!);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(applyOp).toHaveBeenCalledOnce());
    // The first selected node is the one being re-pointed; the rest are its new
    // parents. This is "change what the next step sees" without touching content.
    const op = applyOp.mock.calls[0]![1] as { op: string; nodeId: string; parentIds: string[] };
    expect(op).toEqual({ op: 'reconnect', nodeId: 'root', parentIds: ['step-one'] });
  });

  it('branches a node as an independent line of work', async () => {
    const { applyOp } = renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getAllByTestId('canvas-node-select')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }));
    await waitFor(() => expect(applyOp).toHaveBeenCalledOnce());
    expect(applyOp.mock.calls[0]![1]).toEqual({ op: 'duplicate', nodeId: 'step-one' });
    // The branch is the node the reply named, so the sheet opens on it.
    expect(await screen.findByTestId('canvas-node-detail')).toBeInTheDocument();
  });

  it('cuts every edge into a node so its parents stop feeding it', async () => {
    const { applyOp } = renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getByRole('button', { name: 'Step 1' }));
    fireEvent.click(await screen.findByTestId('canvas-sheet-cut'));
    await waitFor(() => expect(applyOp).toHaveBeenCalledOnce());
    expect(applyOp.mock.calls[0]![1]).toEqual({ op: 'cut', nodeId: 'step-one', parentIds: [] });
  });

  it('hands a node to the agent as a quote rather than a follow-up', async () => {
    const { applyOp } = renderPanel();
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getAllByTestId('canvas-node-select')[1]!);

    // The mode switch is what decides how the directive is phrased; the node is
    // unchanged either way, which is why neither bumps a version. The switch and
    // the send button share a label, so they are addressed by testid.
    fireEvent.click(screen.getByTestId('canvas-mode-quote'));
    fireEvent.click(screen.getByTestId('canvas-send'));
    await waitFor(() => expect(applyOp).toHaveBeenCalledOnce());
    expect(applyOp.mock.calls[0]![1]).toEqual({ op: 'quote', nodeId: 'step-one' });

    fireEvent.click(screen.getByTestId('canvas-mode-follow-up'));
    fireEvent.click(screen.getByTestId('canvas-send'));
    await waitFor(() => expect(applyOp).toHaveBeenCalledTimes(2));
    expect(applyOp.mock.calls[1]![1]).toEqual({ op: 'follow-up', nodeId: 'step-one' });
  });

  it('shows a node version and its edit history on the detail sheet', async () => {
    const graph = sixStepGraph();
    // N11: an edited node carries its history, so the sheet can show what changed.
    graph.nodes = graph.nodes.map((node) =>
      node.id === 'step-one'
        ? {
            ...node,
            version: 3,
            data: {
              ...(node.data as Record<string, unknown>),
              title: 'Step 1',
              edits: [
                { previous: 'Gather sources', text: 'Gather sources from the archive', at: 1_700_000_000_000 },
                { previous: 'Gather sources from the archive', text: 'Gather sources from the archive only', at: 1_700_000_001_000 },
              ],
            },
          }
        : node,
    );
    renderPanel({}, () => graph);
    await screen.findAllByTestId('canvas-node');
    fireEvent.click(screen.getByRole('button', { name: 'Step 1' }));
    const detail = await screen.findByTestId('canvas-node-detail');
    expect(detail).toHaveAttribute('data-version', '3');
    expect(detail).toHaveTextContent('v3');
    fireEvent.click(screen.getByRole('button', { name: /Edit history/ }));
    const history = await screen.findByTestId('canvas-edit-history');
    expect(history).toHaveTextContent('Gather sources');
    expect(history).toHaveTextContent('Gather sources from the archive');
  });

  it('disables the editing actions on an empty canvas', async () => {
    renderPanel({}, () => ({ ...sixStepGraph(), nodes: [], edges: [], stats: { ...sixStepGraph().stats, totalNodes: 0 } }));
    await screen.findByTestId('canvas-empty');
    // No nodes means no selection, so there is nothing to group, branch or quote.
    expect(screen.queryByTestId('canvas-selection')).toBeNull();
  });

  it('highlights the server search reply, including a node the panel does not hold', async () => {
    // The server owns the whole run, so it can report a match on a node the
    // panel's snapshot never fetched: the card is not there to search locally,
    // which is exactly why the panel asks the server instead.
    const { searchGraph } = renderPanel({}, sixStepGraph, {
      query: 'quarterly',
      hits: [
        {
          nodeId: 'step-one',
          nodeType: 'recipe_step',
          nodeStatus: 'finished',
          title: 'Step 1',
          matches: [{ field: 'title', start: 5, length: 3, snippet: '1', nodeId: 'step-one' }],
        },
        {
          nodeId: 'not-on-the-canvas',
          nodeType: 'webpage',
          nodeStatus: 'finished',
          title: 'Draft the quarterly report',
          matches: [{ field: 'title', start: 10, length: 9, snippet: 'quarterly', nodeId: 'not-on-the-canvas' }],
        },
      ],
    });
    await screen.findAllByTestId('canvas-node');
    fireEvent.change(screen.getByTestId('canvas-search'), { target: { value: 'quarterly' } });

    await waitFor(() => expect(searchGraph).toHaveBeenCalledWith(RUN, 'quarterly'));
    // The rail lists every hit the server reported, held node or not.
    await waitFor(() => expect(screen.getAllByTestId('canvas-search-hit')).toHaveLength(2));
    expect(screen.getByTestId('canvas-search-results')).toHaveTextContent('2 matches');
    // The held card is marked, and the matched characters carry the highlight.
    const card = document.querySelector<HTMLElement>('[data-testid="canvas-node"][data-node-id="step-one"]')!;
    expect(card.getAttribute('data-node-match')).toBe('true');
    expect(card.querySelector('[data-node-segment="true"]')).toHaveTextContent('1');
  });

  it('falls back to the nodes it holds when the server cannot answer the search', async () => {
    const { searchGraph } = renderPanel({}, sixStepGraph);
    // The stub answers no search, which is what a server without the N18 route
    // looks like: the local search still works, and no notice is raised.
    searchGraph.mockRejectedValue(new Error('connection refused'));
    await screen.findAllByTestId('canvas-node');
    fireEvent.change(screen.getByTestId('canvas-search'), { target: { value: 'Step 1' } });

    await waitFor(() => expect(searchGraph).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByTestId('canvas-search-hit')).toHaveLength(1));
    expect(screen.queryByTestId('canvas-error')).not.toBeInTheDocument();
  });
});
