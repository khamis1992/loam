'use client';

/**
 * Neo N18: the canvas minimap.
 *
 * A run graph grows past the viewport, so the panel draws a scaled thumbnail in
 * the corner: every node as a dot, the colour tags the user set (N18), the nodes
 * a search matched, and the rectangle the viewport currently covers. A click or
 * drag on the thumbnail pans the canvas, and the nodes are `aria-hidden` because
 * the thumbnail is a control, not a second copy of the graph.
 *
 * The geometry lives in `minimapGeometry.ts`; this file only draws it.
 */
import { useCallback, useMemo, useRef } from 'react';
import type { CanvasLayoutNode } from './types';
import { CANVAS_TAG_COLOUR_CSS, type CanvasTagColour } from './types.annotations';
import {
  graphBounds,
  minimapClickOffset,
  minimapPoint,
  minimapScale,
  minimapViewportRect,
} from './minimapGeometry';

/** Thumbnail size in CSS pixels. */
export const MINIMAP_WIDTH = 168;
export const MINIMAP_HEIGHT = 112;

export interface MinimapProps {
  nodes: CanvasLayoutNode[];
  /** Node footprint in graph space, so the thumbnail's dots match the cards. */
  nodeWidth: number;
  nodeHeight: number;
  /** Graph-space size the viewport currently shows. */
  viewWidth: number;
  viewHeight: number;
  /** Graph-space offset of the viewport's top-left corner. */
  offsetX: number;
  offsetY: number;
  /** node id -> colour tag (N18). */
  tags: Record<string, CanvasTagColour>;
  /** Node ids the current search matched, drawn as rings (N18). */
  matches?: Set<string>;
  /** A click on the thumbnail: pan the canvas to the graph point aimed at. */
  onNavigate?: (offset: { offsetX: number; offsetY: number }) => void;
  tr: (key: string) => string;
}

export function Minimap({
  nodes,
  nodeWidth,
  nodeHeight,
  viewWidth,
  viewHeight,
  offsetX,
  offsetY,
  tags,
  matches,
  onNavigate,
  tr,
}: MinimapProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const size = { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT };
  const bounds = useMemo(() => graphBounds(nodes, nodeWidth, nodeHeight), [nodeHeight, nodes, nodeWidth]);
  const scale = useMemo(() => minimapScale(bounds, size), [bounds]);
  const viewport = minimapViewportRect({ width: viewWidth, height: viewHeight, offsetX, offsetY }, bounds, scale);

  const navigate = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onNavigate) return;
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      // The click is in thumbnail pixels; `minimapClickOffset` turns it back into
      // a graph-space offset, so the viewport lands where the user aimed.
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      onNavigate(minimapClickOffset(point, bounds, scale, { width: viewWidth, height: viewHeight, offsetX, offsetY }));
    },
    [bounds, offsetX, offsetY, onNavigate, scale, viewHeight, viewWidth],
  );

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={navigate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onNavigate?.({ offsetX, offsetY });
      }}
      aria-label={tr('Minimap')}
      title={tr('Minimap')}
      data-testid="canvas-minimap"
      dir="ltr"
      className="absolute bottom-2 end-2 cursor-pointer overflow-hidden rounded-control border border-border-main bg-bg-menu/90 shadow-sm"
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
    >
      <svg width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} aria-hidden="true">
        {nodes.map((node) => {
          const point = minimapPoint({ x: node.x, y: node.y }, bounds, scale);
          const colour = tags[node.id];
          const matched = matches?.has(node.id) ?? false;
          return (
            <rect
              key={node.id}
              x={point.x}
              y={point.y}
              width={Math.max(2, nodeWidth * scale)}
              height={Math.max(2, nodeHeight * scale)}
              rx={1}
              fill={colour && colour !== 'none' ? CANVAS_TAG_COLOUR_CSS[colour] : 'var(--text-quaternary)'}
              stroke={matched ? 'var(--icon-blue)' : 'none'}
              strokeWidth={matched ? 1.5 : 0}
              data-testid="canvas-minimap-node"
              data-node-id={node.id}
              data-node-tag={colour ?? 'none'}
              data-node-match={matched ? 'true' : 'false'}
            />
          );
        })}
        <rect
          x={viewport.x}
          y={viewport.y}
          width={Math.max(4, viewport.width)}
          height={Math.max(4, viewport.height)}
          fill="var(--icon-blue)"
          fillOpacity={0.12}
          stroke="var(--icon-blue)"
          strokeWidth={1}
          data-testid="canvas-minimap-viewport"
        />
      </svg>
    </div>
  );
}

export default Minimap;
