/**
 * Neo N2: the canvas layout rules.
 *
 * The acceptance test's "Organize lays out without overlap" rule is pinned here,
 * without a DOM: depth is derived from parent edges, layers never share a cell,
 * hand-placed duplicates cannot collide, and screen -> graph mapping is exact.
 */
import { describe, expect, it } from 'vitest';

import {
  applyLayout,
  DEFAULT_LAYOUT,
  depthMap,
  hasOverlaps,
  layoutBounds,
  screenToGraph,
} from '../layout';

/** A run with a root, two steps and a tool node hanging off the first step. */
function tree() {
  return [
    { id: 'root', parent_ids: [], position: 1 },
    { id: 'step1', parent_ids: ['root'], position: 2 },
    { id: 'step2', parent_ids: ['root'], position: 3 },
    { id: 'search', parent_ids: ['step1'], position: 4 },
  ];
}

describe('canvas layout depth', () => {
  it('places a root at depth 0 and children one layer deeper', () => {
    const depth = depthMap(tree());
    expect(depth.get('root')).toBe(0);
    expect(depth.get('step1')).toBe(1);
    expect(depth.get('step2')).toBe(1);
    // A child sits one layer below its deepest parent.
    expect(depth.get('search')).toBe(2);
  });

  it('ignores parents that are not on the canvas', () => {
    const depth = depthMap([
      { id: 'orphan', parent_ids: ['gone'], position: 1 },
      { id: 'child', parent_ids: ['orphan'], position: 2 },
    ]);
    // An unknown parent is dropped, not fatal.
    expect(depth.get('orphan')).toBe(0);
    expect(depth.get('child')).toBe(1);
  });

  it('does not recurse forever on a hand-edited cycle', () => {
    const depth = depthMap([
      { id: 'a', parent_ids: ['b'], position: 1 },
      { id: 'b', parent_ids: ['a'], position: 2 },
    ]);
    expect([...depth.values()].every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe('canvas auto-layout (Organize)', () => {
  it('never overlaps: layers stack on y, siblings spread on x', () => {
    const placed = applyLayout(tree());
    expect(placed).toHaveLength(4);
    expect(hasOverlaps(placed)).toBe(false);
    const byId = new Map(placed.map((node) => [node.id, node]));
    // Two siblings share a layer, so they are offset by one column.
    expect(byId.get('step1')!.y).toBe(byId.get('step2')!.y);
    expect(byId.get('step2')!.x - byId.get('step1')!.x).toBe(DEFAULT_LAYOUT.columnWidth);
    // A deeper node is on the next row down.
    expect(byId.get('search')!.y).toBe(byId.get('step1')!.y + DEFAULT_LAYOUT.rowHeight);
  });

  it('keeps every node inside the bounds the scroll surface is sized to', () => {
    const placed = applyLayout(tree());
    const bounds = layoutBounds(placed);
    // The rightmost node is one column from the origin and the deepest is two
    // rows down, so the bounds reach those far edges.
    expect(bounds.width).toBe(DEFAULT_LAYOUT.originX + DEFAULT_LAYOUT.columnWidth);
    expect(bounds.height).toBe(DEFAULT_LAYOUT.originY + DEFAULT_LAYOUT.rowHeight * 2);
    for (const node of placed) {
      // The surface is sized to hold whole nodes, so a node is never clipped.
      expect(node.x).toBeLessThanOrEqual(bounds.width);
      expect(node.y).toBeLessThanOrEqual(bounds.height);
    }
  });

  it('honours a custom column width and origin', () => {
    const placed = applyLayout(tree(), { columnWidth: 100, rowHeight: 50, originX: 10, originY: 20 });
    const byId = new Map(placed.map((node) => [node.id, node]));
    expect(byId.get('root')!.x).toBe(10);
    expect(byId.get('root')!.y).toBe(20);
    expect(byId.get('step2')!.x).toBe(110);
    expect(hasOverlaps(placed)).toBe(false);
  });

  it('drops a duplicate id instead of overlapping on it', () => {
    const placed = applyLayout([
      { id: 'a', parent_ids: [], position: 1 },
      { id: 'a', parent_ids: [], position: 2 },
    ]);
    expect(placed).toHaveLength(1);
    expect(hasOverlaps(placed)).toBe(false);
  });

  it('reports no overlap for an empty canvas', () => {
    expect(applyLayout([])).toEqual([]);
    expect(layoutBounds([])).toEqual({ width: 0, height: 0 });
    expect(hasOverlaps([])).toBe(false);
  });
});

describe('canvas screen-to-graph mapping', () => {
  it('inverts the pan and zoom transform', () => {
    const view = { panX: 30, panY: 50, scale: 2 };
    const graph = screenToGraph({ x: 30 + 200, y: 50 + 120 }, view);
    expect(graph).toEqual({ x: 100, y: 60 });
  });

  it('round-trips with the node position transform used by the panel', () => {
    // A node at graph (120, 40) under view (pan 30/50, scale 2) renders at:
    const view = { panX: 30, panY: 50, scale: 2 };
    const screen = { x: view.panX + 120 * view.scale, y: view.panY + 40 * view.scale };
    expect(screenToGraph(screen, view)).toEqual({ x: 120, y: 40 });
  });
});

describe('canvas layout direction (N21)', () => {
  it('lays an Arabic layer out from the right, keeping the same span as LTR', () => {
    const placed = applyLayout(tree(), { direction: 'rtl' });
    const byId = new Map(placed.map((node) => [node.id, node]));
    // The first sibling reads at the start edge, which is the right in RTL.
    expect(byId.get('step1')!.x).toBe(DEFAULT_LAYOUT.originX + DEFAULT_LAYOUT.columnWidth);
    expect(byId.get('step2')!.x).toBe(DEFAULT_LAYOUT.originX);
    // Layers still stack downward, so only the row is mirrored.
    expect(byId.get('search')!.y).toBe(byId.get('step1')!.y + DEFAULT_LAYOUT.rowHeight);
    expect(byId.get('root')!.y).toBe(DEFAULT_LAYOUT.originY);
  });

  it('produces the same coordinates as LTR, only reassigned to different siblings', () => {
    const ltr = applyLayout(tree(), { direction: 'ltr' });
    const rtl = applyLayout(tree(), { direction: 'rtl' });
    // Mirroring the index cannot invent or drop a column, so the surface the
    // panel sizes itself to is identical in both directions.
    expect(rtl.map((node) => node.x).sort()).toEqual(ltr.map((node) => node.x).sort());
    expect(layoutBounds(rtl)).toEqual(layoutBounds(ltr));
    expect(hasOverlaps(rtl)).toBe(false);
  });

  it('leaves a single-sibling layer untouched in both directions', () => {
    // A root is alone on its layer, so its x cannot depend on the direction.
    expect(applyLayout(tree(), { direction: 'rtl' })[0]!.x).toBe(DEFAULT_LAYOUT.originX);
    expect(applyLayout(tree(), { direction: 'ltr' })[0]!.x).toBe(DEFAULT_LAYOUT.originX);
  });

  it('keeps the direction default when the caller does not ask for one', () => {
    expect(DEFAULT_LAYOUT.direction).toBe('ltr');
    expect(applyLayout(tree())).toEqual(applyLayout(tree(), { direction: 'ltr' }));
  });

  it('mirrors a custom column width and origin consistently', () => {
    const options = { columnWidth: 100, originX: 10, direction: 'rtl' as const };
    const placed = applyLayout(tree(), options);
    const byId = new Map(placed.map((node) => [node.id, node]));
    expect(byId.get('step1')!.x).toBe(110);
    expect(byId.get('step2')!.x).toBe(10);
  });

  it('places a sibling from the right edge of its own layer only', () => {
    // Layers of different widths must not leak into each other: the deep layer
    // holds one node, so it sits at the origin even in RTL.
    const placed = applyLayout(
      [
        { id: 'a', parent_ids: [], position: 1 },
        { id: 'b', parent_ids: [], position: 2 },
        { id: 'c', parent_ids: [], position: 3 },
        { id: 'deep', parent_ids: ['a'], position: 4 },
      ],
      { direction: 'rtl' },
    );
    const byId = new Map(placed.map((node) => [node.id, node]));
    expect(byId.get('a')!.x).toBe(DEFAULT_LAYOUT.originX + DEFAULT_LAYOUT.columnWidth * 2);
    expect(byId.get('c')!.x).toBe(DEFAULT_LAYOUT.originX);
    expect(byId.get('deep')!.x).toBe(DEFAULT_LAYOUT.originX);
  });
});
