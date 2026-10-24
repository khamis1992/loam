/**
 * Neo N2: the canvas data contract.
 *
 * The panel never trusts the server, so every payload crossing the boundary is
 * coerced. These tests pin what a real reply must look like and what a malformed
 * one is allowed to do: be dropped, never throw.
 */
import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_STATUSES,
  CANVAS_NODE_TYPES,
  coerceCanvasGraphResponse,
  coerceCanvasLayout,
  coerceCanvasLayoutNode,
  coerceCanvasNode,
  coerceCanvasStats,
  isCanvasNodeStatus,
  isCanvasNodeType,
} from '../types';

const RUN = 'task_canvas_1';

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    run_id: RUN,
    parent_ids: [],
    type: 'recipe_step',
    status: 'running',
    data: { title: 'Gather sources', stepId: 's1' },
    position: 3,
    version: 2,
    created: 1,
    updated: 2,
    ...overrides,
  };
}

describe('canvas payload coercion', () => {
  it('accepts every node type and status the server can send', () => {
    expect(CANVAS_NODE_TYPES).toContain('question');
    expect(CANVAS_NODE_TYPES).toContain('failed');
    expect(CANVAS_NODE_STATUSES).toContain('skipped');
    expect(isCanvasNodeType('recipe_step')).toBe(true);
    expect(isCanvasNodeType('nonsense')).toBe(false);
    expect(isCanvasNodeStatus('finished')).toBe(true);
    expect(isCanvasNodeStatus('done')).toBe(false);
  });

  it('keeps the server placement of a laid-out node', () => {
    // The server lays a run out (`getGraphLayout`), so a card is only drawable if
    // `x`, `y` and `depth` survive coercion; without them the panel renders
    // `translate(NaNpx, NaNpx)`, which a browser drops as invalid.
    const parsed = coerceCanvasLayoutNode(node({ x: 280, y: 240, depth: 1 }));
    expect(parsed).toMatchObject({ id: 'n1', x: 280, y: 240, depth: 1 });
    // An unplaced node lands at the origin rather than at NaN.
    expect(coerceCanvasLayoutNode(node())).toMatchObject({ x: 0, y: 0, depth: 0 });
    expect(coerceCanvasLayoutNode(node({ x: 'nope', y: null, depth: Number.NaN }))).toMatchObject({
      x: 0,
      y: 0,
      depth: 0,
    });
    expect(coerceCanvasLayoutNode({ id: 'bad' })).toBeUndefined();
  });

  it('keeps a well-formed node and its payload', () => {
    const parsed = coerceCanvasNode(node());
    expect(parsed).toMatchObject({
      id: 'n1',
      run_id: RUN,
      type: 'recipe_step',
      status: 'running',
      position: 3,
      version: 2,
    });
    expect(parsed!.data).toEqual({ title: 'Gather sources', stepId: 's1' });
  });

  it('fills safe defaults instead of throwing on a partial node', () => {
    const parsed = coerceCanvasNode({ id: 'n2', run_id: RUN, type: 'note', status: 'init' });
    expect(parsed).toBeDefined();
    expect(parsed!.parent_ids).toEqual([]);
    expect(parsed!.version).toBe(1);
    expect(parsed!.data).toBeUndefined();
  });

  it('drops a node with a missing id, run, type or status', () => {
    expect(coerceCanvasNode(null)).toBeUndefined();
    expect(coerceCanvasNode({})).toBeUndefined();
    expect(coerceCanvasNode({ id: 'n', run_id: RUN, type: 'note' })).toBeUndefined();
    expect(coerceCanvasNode({ id: 'n', run_id: RUN, status: 'init' })).toBeUndefined();
    // An unknown type is not a node the canvas can draw.
    expect(coerceCanvasNode(node({ type: 'mystery' }))).toBeUndefined();
    // Non-string parents are filtered rather than kept as junk.
    const filtered = coerceCanvasNode(node({ parent_ids: ['a', 7, null] }));
    expect(filtered?.parent_ids).toEqual(['a']);
  });

  it('rejects a layout whose nodes or edges are not arrays', () => {
    expect(coerceCanvasLayout(null)).toBeUndefined();
    expect(coerceCanvasLayout({})).toBeUndefined();
    expect(coerceCanvasLayout({ nodes: {}, edges: [] })).toBeUndefined();
    const parsed = coerceCanvasLayout({
      nodes: [node(), node({ id: 'n2', type: 'search' }), { id: 'bad' }],
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n1' }, 'junk'],
      stats: { totalNodes: 2 },
    });
    // Unusable nodes and edges are skipped, not fatal.
    expect(parsed!.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(parsed!.edges).toEqual([{ from: 'n1', to: 'n2' }]);
  });

  it('parses stats, defaulting the maps when they are absent', () => {
    expect(coerceCanvasStats({ totalNodes: 7 })).toEqual({
      totalNodes: 7,
      nodesByType: {},
      nodesByStatus: {},
      depth: 0,
      edges: 0,
    });
    expect(coerceCanvasStats(null)).toBeUndefined();
    expect(coerceCanvasStats({})).toBeUndefined();
  });

  it('reads a server GET reply, including the incremental `fresh` nodes', () => {
    const parsed = coerceCanvasGraphResponse({
      runId: RUN,
      enabled: true,
      nodes: [node({ x: 40, y: 40, depth: 0 })],
      edges: [{ from: 'n1', to: 'n2' }],
      stats: { totalNodes: 1, nodesByType: { recipe_step: 1 }, nodesByStatus: { running: 1 }, depth: 1, edges: 0 },
      fresh: [node({ id: 'n2', position: 4 })],
    });
    expect(parsed!.runId).toBe(RUN);
    expect(parsed!.enabled).toBe(true);
    expect(parsed!.nodes).toHaveLength(1);
    // The cursor reply is the only place new nodes arrive, so it must be kept.
    expect(parsed!.fresh.map((n) => n.id)).toEqual(['n2']);
  });

  it('treats a missing `enabled` flag as enabled, like the route does', () => {
    expect(coerceCanvasGraphResponse({ runId: RUN, nodes: [], edges: [] })!.enabled).toBe(true);
    expect(coerceCanvasGraphResponse({ runId: RUN, enabled: false, nodes: [], edges: [] })!.enabled).toBe(false);
  });

  it('rejects a reply without a run id or a layout', () => {
    expect(coerceCanvasGraphResponse(null)).toBeUndefined();
    expect(coerceCanvasGraphResponse({ nodes: [], edges: [] })).toBeUndefined();
    expect(coerceCanvasGraphResponse({ runId: RUN, nodes: 'nope', edges: [] })).toBeUndefined();
  });
});
