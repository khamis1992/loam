/**
 * Neo N2: the canvas layout, as a pure function.
 *
 * The server already returns a layered layout (`RunGraph.getGraphLayout`), but the
 * canvas must also lay out the nodes the user moves by hand and the deltas that
 * arrive over the live stream, without asking the server to recompute. This module
 * holds that geometry so it can be tested without a DOM or a server.
 *
 * The rule the acceptance test pins: no two nodes may overlap. Layers are stacked
 * on the y axis and siblings are spaced on the x axis, so two nodes can only share
 * a cell if the caller hands us a duplicate id, which `applyLayout` rejects.
 */

/** Geometry of one placed node. */
export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  depth: number;
}

export interface LayoutOptions {
  /** Horizontal gap between siblings in the same layer. */
  columnWidth?: number;
  /** Vertical gap between layers. */
  rowHeight?: number;
  /** Left offset of the first column. */
  originX?: number;
  /** Top offset of the first layer. */
  originY?: number;
  /**
   * Reading direction of the sibling order. Layers always stack top to bottom,
   * but in `rtl` the first sibling of a layer sits at the start edge, which is
   * the right-hand side. The row is therefore mirrored around its own width, so
   * every coordinate stays non-negative and the scroll surface still begins at
   * (originX, originY).
   */
  direction?: 'ltr' | 'rtl';
}

export const DEFAULT_LAYOUT: Required<LayoutOptions> = {
  columnWidth: 280,
  rowHeight: 200,
  originX: 40,
  originY: 40,
  direction: 'ltr',
};

/**
 * The x of a sibling, honouring the reading direction. A layer is always read
 * start-to-end, so in RTL the first sibling is the right-most one. Mirroring the
 * index (rather than negating x) keeps the row in the same span as LTR, so the
 * scroll surface, the bounds and the pan/zoom transform need no RTL branch.
 */
export function siblingX(
  index: number,
  layerCount: number,
  direction: 'ltr' | 'rtl',
  options: Pick<Required<LayoutOptions>, 'originX' | 'columnWidth'> = DEFAULT_LAYOUT,
): number {
  const slot = direction === 'rtl' ? layerCount - 1 - index : index;
  return options.originX + slot * options.columnWidth;
}

/** Depth of each node: roots at 0, a child one deeper than its deepest parent. */
export function depthMap(
  nodes: Array<{ id: string; parent_ids: string[]; position?: number }>,
): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A cycle would recurse forever; treat a node already on the stack as a root
    // so a hand-edited edge can never hang the canvas.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = byId.get(id);
    const parents = node ? node.parent_ids.filter((parent) => byId.has(parent)) : [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(visit)) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };

  for (const node of nodes) visit(node.id);
  return depth;
}

/**
 * Place every node on a grid. Nodes are grouped by depth and, within a layer,
 * ordered by their `order` hint (event order) so the layout is deterministic.
 * Duplicate ids are dropped: the first occurrence wins.
 */
export function applyLayout<T extends { id: string; parent_ids: string[]; position?: number }>(
  nodes: T[],
  options: LayoutOptions = {},
): Array<PlacedNode & { order: number }> {
  const opts = { ...DEFAULT_LAYOUT, ...options };
  const unique = new Map<string, T>();
  for (const node of nodes) if (!unique.has(node.id)) unique.set(node.id, node);

  const depth = depthMap([...unique.values()]);

  // How many siblings share each layer. RTL needs the count up front: the first
  // sibling is the right-most, so its column depends on how wide the row is.
  const layerSize = new Map<number, number>();
  for (const node of unique.values()) {
    const layer = depth.get(node.id) ?? 0;
    layerSize.set(layer, (layerSize.get(layer) ?? 0) + 1);
  }

  const perLayer = new Map<number, number>();
  const placed: Array<PlacedNode & { order: number }> = [];

  for (const node of unique.values()) {
    const layer = depth.get(node.id) ?? 0;
    const index = perLayer.get(layer) ?? 0;
    perLayer.set(layer, index + 1);
    placed.push({
      id: node.id,
      x: siblingX(index, layerSize.get(layer) ?? 1, opts.direction, opts),
      y: opts.originY + layer * opts.rowHeight,
      depth: layer,
      order: node.position ?? 0,
    });
  }
  return placed;
}

/** Bounding box of a placed layout, used to size the scroll surface. */
export function layoutBounds(nodes: Array<{ x: number; y: number }>): { width: number; height: number } {
  if (nodes.length === 0) return { width: 0, height: 0 };
  let maxX = 0;
  let maxY = 0;
  for (const node of nodes) {
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  // The far edge of the rightmost/lowest node's origin; the panel adds the node
  // footprint on top, so the surface always holds whole nodes.
  return { width: maxX, height: maxY };
}

/** True when no two placed nodes share a cell (the acceptance rule). */
export function hasOverlaps(nodes: Array<{ id: string; x: number; y: number }>): boolean {
  const seen = new Set<string>();
  for (const node of nodes) {
    const key = `${node.x},${node.y}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** Scale a point from screen space into graph space for a given pan/zoom. */
export function screenToGraph(
  point: { x: number; y: number },
  view: { panX: number; panY: number; scale: number },
): { x: number; y: number } {
  return {
    x: (point.x - view.panX) / view.scale,
    y: (point.y - view.panY) / view.scale,
  };
}
