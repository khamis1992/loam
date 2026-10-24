/**
 * Neo N13: the node-action panels in the canvas detail sheet (G18, G19).
 *
 * The acceptance criteria for N13 are behavioural, not structural: a document
 * node must expose its version history with a real diff, "Add to Knowledge Base"
 * must show the seeds it *would* write before writing them, and a webpage node
 * must offer the sandbox preview and the ZIP download. These tests drive the real
 * `CanvasPanel` with an injected client, so the same code path the app runs is the
 * one being checked: no network, no server.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasPanel, type CanvasPanelProps } from '../CanvasPanel';
import { CanvasClient } from '../client';
import { CanvasStream } from '../stream';
import type { CanvasGraphResponse, CanvasLayoutNode } from '../types';
import type { CanvasArtifactInfo, CanvasDiff, CanvasKnowledgePreview, CanvasVersionList } from '../nodeActions';

const RUN = 'task_canvas_node_actions';

/** A document node with two captured versions, which is what G18 describes. */
function versionedNode(id: string, type: 'document' | 'webpage' = 'document'): CanvasLayoutNode {
  return {
    id,
    run_id: RUN,
    parent_ids: [],
    type,
    status: 'finished',
    data: { title: 'Landing page', path: 'site/index.html' },
    position: 1,
    version: 3,
    created: 1,
    updated: 3,
    x: 40,
    y: 40,
    depth: 0,
  };
}

function graphFor(nodes: CanvasLayoutNode[]): CanvasGraphResponse {
  return {
    runId: RUN,
    enabled: true,
    nodes,
    edges: [],
    stats: {
      totalNodes: nodes.length,
      nodesByType: nodes.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n.type]: (acc[n.type] ?? 0) + 1 }), {}),
      nodesByStatus: { finished: nodes.length },
      depth: 0,
      edges: 0,
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

const VERSIONS: CanvasVersionList = {
  nodeId: 'doc-1',
  runId: RUN,
  type: 'document',
  current: 2,
  versions: [
    { version: 1, title: 'Landing page', source: 'agent', created: 1, createdAt: '2026-01-01T00:00:00.000Z', nodeVersion: 1, type: 'document', content: 'Hello\nWorld\n' },
    { version: 2, title: 'Landing page', source: 'user', created: 2, createdAt: '2026-01-02T00:00:00.000Z', nodeVersion: 3, type: 'document', content: 'Hello\nThere\nWorld\n' },
  ],
  files: [],
};

const DIFF: CanvasDiff = {
  nodeId: 'doc-1',
  from: 1,
  to: 2,
  added: 1,
  removed: 0,
  unchanged: 2,
  empty: false,
  lines: [
    { op: 'equal', text: 'Hello', oldLine: 1, newLine: 1 },
    { op: 'insert', text: 'There', oldLine: null, newLine: 2 },
    { op: 'equal', text: 'World', oldLine: 2, newLine: 3 },
  ],
};

const KNOWLEDGE: CanvasKnowledgePreview = {
  nodeId: 'doc-1',
  baseName: 'Landing page',
  count: 2,
  seeds: [
    { title: 'Hero copy', body: 'Hello There World', tags: ['copy'] },
    { title: 'Footer', body: 'World', tags: [] },
  ],
  warnings: [],
};

const ARTIFACT: CanvasArtifactInfo = {
  nodeId: 'web-1',
  runId: RUN,
  dir: 'C:\\work\\site',
  entry: 'index.html',
  explicit: true,
  url: `/api/graph/${encodeURIComponent(RUN)}/nodes/web-1/preview`,
  zipUrl: `/api/graph/${encodeURIComponent(RUN)}/nodes/web-1/artifact.zip`,
};

interface NodeActionHarness {
  client: CanvasClient;
  getGraph: ReturnType<typeof vi.fn>;
  getNodeVersions: ReturnType<typeof vi.fn>;
  getNodeDiff: ReturnType<typeof vi.fn>;
  captureNodeVersion: ReturnType<typeof vi.fn>;
  previewNodeKnowledge: ReturnType<typeof vi.fn>;
  addToKnowledgeBase: ReturnType<typeof vi.fn>;
  getNodeArtifact: ReturnType<typeof vi.fn>;
  startNodePreview: ReturnType<typeof vi.fn>;
  downloadNodeZip: ReturnType<typeof vi.fn>;
  listKnowledgeBases: ReturnType<typeof vi.fn>;
}

/**
 * An injected client whose node-action methods are spies. The defaults answer
 * with the payloads above, so each test only overrides the one it cares about.
 */
function harness(
  nodes: CanvasLayoutNode[],
  overrides: Partial<Record<keyof NodeActionHarness, unknown>> = {},
): NodeActionHarness {
  const getGraph = vi.fn(async () => graphFor(nodes));
  const getNodeVersions = vi.fn(async () => VERSIONS);
  const getNodeDiff = vi.fn(async () => DIFF);
  const captureNodeVersion = vi.fn(async () => ({ ok: true, version: 3, versions: VERSIONS.versions }));
  const previewNodeKnowledge = vi.fn(async () => KNOWLEDGE);
  const addToKnowledgeBase = vi.fn(async () => ({
    ok: true,
    baseId: 'kb-1',
    baseName: 'Research',
    smartSplit: true,
    seeds: KNOWLEDGE.seeds.map((seed, index) => ({ id: `seed-${index}`, ...seed })),
    warnings: [],
  }));
  const getNodeArtifact = vi.fn(async () => ARTIFACT);
  const startNodePreview = vi.fn(async () => ({ url: 'http://127.0.0.1:4100/', root: ARTIFACT.dir }));
  const downloadNodeZip = vi.fn(async () => new Blob(['PK'], { type: 'application/zip' }));
  const listKnowledgeBases = vi.fn(async () => [{ id: 'kb-1', name: 'Research', seeds: 4 }]);
  const client = {
    getGraph,
    getNodeVersions,
    getNodeDiff,
    captureNodeVersion,
    previewNodeKnowledge,
    addToKnowledgeBase,
    getNodeArtifact,
    startNodePreview,
    downloadNodeZip,
    listKnowledgeBases,
    ...overrides,
  } as unknown as CanvasClient;
  return {
    client,
    getGraph,
    getNodeVersions,
    getNodeDiff,
    captureNodeVersion,
    previewNodeKnowledge,
    addToKnowledgeBase,
    getNodeArtifact,
    startNodePreview,
    downloadNodeZip,
    listKnowledgeBases,
  };
}

function renderPanel(nodes: CanvasLayoutNode[], overrides: Partial<CanvasPanelProps> = {}) {
  const h = harness(nodes);
  render(
    <CanvasPanel taskId={RUN} live={false} client={h.client} stream={idleStream()} events={[]} {...overrides} />,
  );
  return h;
}

/**
 * Open the newest node's detail sheet the way a user does. The graph is fetched
 * asynchronously, so the panel has to have its nodes before E means anything.
 */
async function openDetail(): Promise<void> {
  await screen.findAllByTestId('canvas-node');
  fireEvent.keyDown(window, { key: 'e' });
  await screen.findByTestId('canvas-node-detail');
}

describe('canvas node actions', () => {
  // jsdom has no window.open; the panel calls it, and a throw would read as a
  // panel failure rather than a missing browser feature.
  beforeEach(() => {
    vi.stubGlobal('open', vi.fn());
  });

  it('shows the version history and the line diff of a document node', async () => {
    const h = renderPanel([versionedNode('doc-1')]);
    await openDetail();
    // The panel fetches versions, then the diff of the pair it defaults to.
    expect(await screen.findByTestId('canvas-versions')).toBeInTheDocument();
    expect(h.getNodeVersions).toHaveBeenCalledWith(RUN, 'doc-1');
    await waitFor(() => expect(h.getNodeDiff).toHaveBeenCalledWith(RUN, 'doc-1', 1, 2));
    expect(screen.getByTestId('canvas-versions-count')).toHaveTextContent('2 versions');
    // The diff is the real one: added/removed counts and the aligned lines.
    const diff = await screen.findByTestId('canvas-diff');
    expect(diff).toHaveAttribute('data-from', '1');
    expect(diff).toHaveAttribute('data-to', '2');
    expect(screen.getByTestId('canvas-diff-added')).toHaveTextContent('+1 Added');
    expect(screen.getByTestId('canvas-diff-removed')).toHaveTextContent('−0 Removed');
    expect(screen.getByText('There')).toBeInTheDocument();
  });

  it('captures a snapshot and refreshes the history', async () => {
    const h = renderPanel([versionedNode('doc-1')]);
    await openDetail();
    await screen.findByTestId('canvas-versions');
    fireEvent.click(await screen.findByRole('button', { name: 'Capture a snapshot' }));
    await waitFor(() => expect(h.captureNodeVersion).toHaveBeenCalledWith(RUN, 'doc-1'));
    // A capture is confirmed, and the list is re-read so the new version appears.
    expect(await screen.findByTestId('canvas-versions-captured')).toHaveTextContent('Captured version 3');
    expect(h.getNodeVersions.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('previews the seeds before adding a node to the Knowledge Base', async () => {
    const h = renderPanel([versionedNode('doc-1')]);
    await openDetail();
    // The preview is what the user sees first, and nothing is written yet.
    expect(await screen.findByTestId('canvas-knowledge')).toBeInTheDocument();
    expect(h.previewNodeKnowledge).toHaveBeenCalledWith(RUN, 'doc-1');
    expect(screen.getByTestId('canvas-knowledge-count')).toHaveTextContent('2 seeds');
    expect(screen.getAllByTestId('canvas-knowledge-seed')).toHaveLength(2);
    expect(screen.getByText('Hero copy')).toBeInTheDocument();
    expect(h.addToKnowledgeBase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add to Knowledge Base' }));
    await waitFor(() => expect(h.addToKnowledgeBase).toHaveBeenCalledWith(RUN, 'doc-1', { baseId: 'kb-1' }));
    // The result names the base the seeds landed in, so the user can find them.
    expect(await screen.findByTestId('canvas-knowledge-done')).toHaveTextContent('Added 2 seeds to Research');
  });

  it('says when a node carries no text to add', async () => {
    renderPanel([versionedNode('doc-1')], {
      // The preview reports an empty node; the panel must say so, not offer an action.
      client: harness([versionedNode('doc-1')], {
        previewNodeKnowledge: vi.fn(async () => ({ ...KNOWLEDGE, count: 0, seeds: [], warnings: ['this node carries no text'] })),
      }).client,
    });
    await openDetail();
    expect(await screen.findByTestId('canvas-knowledge-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to Knowledge Base' })).toBeNull();
  });

  it('surfaces a failed knowledge preview as a sentence, not a crash', async () => {
    renderPanel([versionedNode('doc-1')], {
      client: harness([versionedNode('doc-1')], {
        previewNodeKnowledge: vi.fn(async () => {
          throw new Error('embedder unreachable');
        }),
      }).client,
    });
    await openDetail();
    const error = await screen.findByTestId('canvas-knowledge-error');
    expect(error).toHaveTextContent('embedder unreachable');
  });

  it('offers the sandbox preview and the ZIP download on a webpage node', async () => {
    const h = renderPanel([versionedNode('web-1', 'webpage')]);
    await openDetail();
    const panel = await screen.findByTestId('canvas-webpage');
    expect(panel).toBeInTheDocument();
    expect(h.getNodeArtifact).toHaveBeenCalledWith(RUN, 'web-1');

    // "Open in sandbox" asks the server to start the preview, then opens it.
    fireEvent.click(screen.getByRole('button', { name: /Open in sandbox/i }));
    await waitFor(() => expect(h.startNodePreview).toHaveBeenCalledWith(RUN, 'web-1'));

    // The ZIP is fetched and handed to the browser as a download.
    fireEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
    await waitFor(() => expect(h.downloadNodeZip).toHaveBeenCalledWith(RUN, 'web-1'));
  });

  it('hides the webpage actions for a document node', async () => {
    renderPanel([versionedNode('doc-1')]);
    await openDetail();
    await screen.findByTestId('canvas-versions');
    expect(screen.queryByTestId('canvas-webpage')).toBeNull();
  });

  it('says when a webpage node has no artifact directory', async () => {
    renderPanel([versionedNode('web-1', 'webpage')], {
      client: harness([versionedNode('web-1', 'webpage')], {
        getNodeArtifact: vi.fn(async () => {
          throw new Error('no artifact directory for this node');
        }),
      }).client,
    });
    await openDetail();
    expect(await screen.findByTestId('canvas-webpage-error')).toBeInTheDocument();
  });
});
