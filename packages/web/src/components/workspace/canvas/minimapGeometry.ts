/**
 * Neo N18: the minimap, as pure geometry.
 *
 * A run graph can be far larger than the viewport, so the canvas shows a scaled
 * thumbnail of it. The maths lives here, without a DOM, so the mapping between
 * graph space, the thumbnail and the viewport is testable on its own.
 *
 * The rule the acceptance test pins: the thumbnail and the viewport describe the
 * same rectangle of graph space, so clicking the thumbnail pans the canvas to
 * exactly what the user aimed at.
 */

/** A rectangle in graph space. */
export interface GraphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A view: which part of graph space the viewport shows, at what scale. */
export interface MinimapView {
  /** Graph-space width the viewport covers (screen width / scale). */
  width: number;
  /** Graph-space height the viewport covers. */
  height: number;
  /** Graph-space offset of the viewport's top-left corner. */
  offsetX: number;
  offsetY: number;
}

export interface MinimapOptions {
  /** Thumbnail size in CSS pixels. */
  width: number;
  height: number;
}

/** The bounding box of a graph, including the footprint of the lowest/rightmost node. */
export function graphBounds(nodes: Array<{ x: number; y: number }>, nodeWidth = 0, nodeHeight = 0): GraphRect {
  if (nodes.length === 0) return { x: 0, y: 0, width: nodeWidth, height: nodeHeight };
  // Start from the first node, not the origin: a graph whose nodes all sit left
  // of zero must be measured from the leftmost one, or the bounds would silently
  // grow past the canvas and the thumbnail would misplace every dot.
  let minX = nodes[0]!.x;
  let minY = nodes[0]!.y;
  let maxX = minX;
  let maxY = minY;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  return { x: minX, y: minY, width: maxX - minX + nodeWidth, height: maxY - minY + nodeHeight };
}

/** The single scale that fits a graph inside a thumbnail, never below `minScale`. */
export function minimapScale(bounds: GraphRect, options: MinimapOptions, minScale = 0.05): number {
  if (bounds.width <= 0 || bounds.height <= 0) return minScale;
  const scaleX = options.width / bounds.width;
  const scaleY = options.height / bounds.height;
  return Math.max(minScale, Math.min(scaleX, scaleY));
}

/** Where a graph-space point lands inside the thumbnail. */
export function minimapPoint(
  point: { x: number; y: number },
  bounds: GraphRect,
  scale: number,
): { x: number; y: number } {
  return { x: (point.x - bounds.x) * scale, y: (point.y - bounds.y) * scale };
}

/** The thumbnail rectangle that represents the viewport. */
export function minimapViewportRect(
  view: MinimapView,
  bounds: GraphRect,
  scale: number,
): GraphRect {
  return {
    x: (view.offsetX - bounds.x) * scale,
    y: (view.offsetY - bounds.y) * scale,
    width: view.width * scale,
    height: view.height * scale,
  };
}

/** True when a viewport rectangle is entirely inside the thumbnail. */
export function viewportFits(rect: GraphRect, options: MinimapOptions): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= options.width && rect.y + rect.height <= options.height;
}

/**
 * The graph-space offset that centres a viewport rectangle on a thumbnail point.
 * Used by a click on the minimap: the user aims at a graph-space location, and
 * the viewport's centre moves there.
 */
export function minimapClickOffset(
  point: { x: number; y: number },
  bounds: GraphRect,
  scale: number,
  view: MinimapView,
): { offsetX: number; offsetY: number } {
  const graphX = bounds.x + point.x / scale;
  const graphY = bounds.y + point.y / scale;
  return { offsetX: graphX - view.width / 2, offsetY: graphY - view.height / 2 };
}

/** True when a viewport rectangle lies entirely inside the graph. */
function insideBounds(view: MinimapView, bounds: GraphRect): boolean {
  return view.offsetX >= bounds.x && view.offsetY >= bounds.y && view.offsetX + view.width <= bounds.x + bounds.width;
}

/**
 * Clamp a viewport to the graph. A graph smaller than the viewport is centred
 * rather than pinned to a corner, and a viewport that already fits is left where
 * the user put it, so a pan never jumps under them.
 */
export function clampView(view: MinimapView, bounds: GraphRect): MinimapView {
  if (insideBounds(view, bounds)) return view;
  const maxX = bounds.x + bounds.width - view.width;
  const maxY = bounds.y + bounds.height - view.height;
  // A viewport wider than the graph has no interior offset at all: the only
  // place that shows the whole graph is centred on it.
  const offsetX = maxX < bounds.x ? bounds.x + (bounds.width - view.width) / 2 : Math.min(Math.max(view.offsetX, bounds.x), maxX);
  const offsetY = maxY < bounds.y ? bounds.y + (bounds.height - view.height) / 2 : Math.min(Math.max(view.offsetY, bounds.y), maxY);
  return { ...view, offsetX, offsetY };
}
