/**
 * Neo N2: the Canvas editor's data contract.
 *
 * These types mirror the N1 server model (`src/graph/store.ts`) and the layout
 * the server returns (`src/server/routes/graph.ts`). They are shared by the
 * panel, the client and the tests, so a layout produced by the server and the
 * one rendered by the canvas cannot drift apart.
 */
import type { CanvasSearchHit as SearchCanvasHit } from './search';

/** Every node kind the graph can render (mirrors RUN_NODE_TYPES). */
export const CANVAS_NODE_TYPES = [
  'question',
  'recipe_step',
  'search',
  'document',
  'webpage',
  'media',
  'ask_user',
  'complete',
  'sibling',
  'branch',
  'merge',
  'note',
  'failed',
] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/** Lifecycle of one node (mirrors RUN_NODE_STATUSES). */
export const CANVAS_NODE_STATUSES = ['init', 'running', 'finished', 'failed', 'skipped'] as const;
export type CanvasNodeStatus = (typeof CANVAS_NODE_STATUSES)[number];

/** One node of a run graph. */
export interface CanvasNode {
  id: string;
  /** Owning run (Loam task id). */
  run_id: string;
  /** Nodes this node consumes context from; multiple parents = merged context. */
  parent_ids: string[];
  type: CanvasNodeType;
  status: CanvasNodeStatus;
  data?: unknown;
  /** Ordering hint within the run; stable across replay. */
  position?: number;
  version: number;
  created: number;
  updated: number;
}

/** A node placed by the layered layout, plus its layer depth. */
export interface CanvasLayoutNode extends CanvasNode {
  x: number;
  y: number;
  depth: number;
}

export interface CanvasEdge {
  from: string;
  to: string;
}

export interface CanvasStats {
  totalNodes: number;
  nodesByType: Record<string, number>;
  nodesByStatus: Record<string, number>;
  depth: number;
  edges: number;
}

/** The whole graph the Canvas tab renders. */
export interface CanvasLayout {
  nodes: CanvasLayoutNode[];
  edges: CanvasEdge[];
  /** Absent when the run has no graph yet; the panel falls back to counting nodes. */
  stats?: CanvasStats;
}

/** Tally a collection by a key, for the counts the stats block reports. */
function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const name = key(item);
    acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {});
}

/** One hit inside one field of one node, as the server reports it. */
export interface CanvasNodeMatch {
  field: string;
  /** Character offset of the hit inside the field's original value. */
  start: number;
  /** Length of the hit in the original value (a folded hit can be longer). */
  length: number;
  /** The matched text, verbatim from the node. */
  snippet: string;
}

/**
 * One node plus the hits that matched it, as the server reports them. The shape
 * is `./search`'s `CanvasSearchHit` (the two sides mirror each other), so a
 * server reply and a locally computed result are interchangeable to the panel.
 */
export type CanvasSearchHit = SearchCanvasHit;

/**
 * The `search` block of the server's GET reply. `GET /api/graph/:runId?q=…`
 * scans the *whole* run, including nodes this client has not fetched yet, so a
 * client that does not hold the entire graph can still highlight every match.
 * Absent when the caller did not ask for a search.
 */
export interface CanvasGraphSearch {
  query: string;
  hits: CanvasSearchHit[];
}

/** The server's GET /api/graph/:runId reply. */
export interface CanvasGraphResponse {
  runId: string;
  enabled: boolean;
  nodes: CanvasLayoutNode[];
  edges: CanvasEdge[];
  stats: CanvasStats;
  /** Nodes appended after the `afterSeq` cursor the caller already rendered. */
  fresh: CanvasNode[];
  /** Present only when the caller sent `?q=`; see `CanvasGraphSearch`. */
  search?: CanvasGraphSearch;
}

/** A canvas edit, sent as PATCH /api/graph/:runId/nodes/:nodeId. */
export interface CanvasNodePatch {
  status?: CanvasNodeStatus;
  data?: unknown;
  parentIds?: string[];
}

export const isCanvasNodeType = (value: unknown): value is CanvasNodeType =>
  typeof value === 'string' && (CANVAS_NODE_TYPES as readonly string[]).includes(value);

export const isCanvasNodeStatus = (value: unknown): value is CanvasNodeStatus =>
  typeof value === 'string' && (CANVAS_NODE_STATUSES as readonly string[]).includes(value);

/** Coerce an unknown payload into a CanvasNode; undefined when unusable. */
export function coerceCanvasNode(value: unknown): CanvasNode | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.run_id !== 'string') return undefined;
  if (!isCanvasNodeType(raw.type) || !isCanvasNodeStatus(raw.status)) return undefined;
  return {
    id: raw.id,
    run_id: raw.run_id,
    parent_ids: Array.isArray(raw.parent_ids) ? raw.parent_ids.filter((p): p is string => typeof p === 'string') : [],
    type: raw.type,
    status: raw.status,
    ...(raw.data !== undefined ? { data: raw.data } : {}),
    ...(typeof raw.position === 'number' && Number.isFinite(raw.position) ? { position: raw.position } : {}),
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1,
    created: typeof raw.created === 'number' && Number.isFinite(raw.created) ? raw.created : 0,
    updated: typeof raw.updated === 'number' && Number.isFinite(raw.updated) ? raw.updated : 0,
  };
}

/** A finite number from an unknown payload, else `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Coerce an unknown payload into a placed node. The server lays a run out
 * (`RunGraph.getGraphLayout`), so `x`, `y` and `depth` are part of the reply and
 * must survive coercion: dropping them draws every card at `translate(NaNpx)`,
 * which the browser discards, leaving an empty canvas. A node the server did not
 * place still lands at the origin rather than at NaN.
 */
export function coerceCanvasLayoutNode(value: unknown): CanvasLayoutNode | undefined {
  const node = coerceCanvasNode(value);
  if (!node) return undefined;
  const raw = value as Record<string, unknown>;
  return { ...node, x: finiteOr(raw.x, 0), y: finiteOr(raw.y, 0), depth: finiteOr(raw.depth, 0) };
}

/** Coerce an unknown payload into a CanvasLayout; undefined when unusable. */
export function coerceCanvasLayout(value: unknown): CanvasLayout | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return undefined;
  const nodes = raw.nodes.map(coerceCanvasLayoutNode).filter((n): n is CanvasLayoutNode => n !== undefined);
  const edges: CanvasEdge[] = [];
  for (const edge of raw.edges) {
    if (typeof edge !== 'object' || edge === null) continue;
    const e = edge as Record<string, unknown>;
    if (typeof e.from === 'string' && typeof e.to === 'string') edges.push({ from: e.from, to: e.to });
  }
  const stats = coerceCanvasStats(raw.stats);
  return { nodes, edges, ...(stats ? { stats } : {}) };
}

export function coerceCanvasStats(value: unknown): CanvasStats | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.totalNodes !== 'number') return undefined;
  const asRecordOf = (v: unknown): Record<string, number> | undefined =>
    typeof v === 'object' && v !== null
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, n]) => [k, Number(n)]))
      : undefined;
  return {
    totalNodes: raw.totalNodes,
    nodesByType: asRecordOf(raw.nodesByType) ?? {},
    nodesByStatus: asRecordOf(raw.nodesByStatus) ?? {},
    depth: typeof raw.depth === 'number' ? raw.depth : 0,
    edges: typeof raw.edges === 'number' ? raw.edges : 0,
  };
}

/** Coerce one hit of a server search reply; undefined when unusable. */
function coerceCanvasSearchHit(value: unknown): CanvasSearchHit | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.nodeId !== 'string') return undefined;
  const matches = Array.isArray(raw.matches)
    ? raw.matches
        .map((entry) => {
          if (typeof entry !== 'object' || entry === null) return undefined;
          const match = entry as Record<string, unknown>;
          if (typeof match.field !== 'string' || typeof match.snippet !== 'string') return undefined;
          return {
            field: match.field,
            start: typeof match.start === 'number' && Number.isFinite(match.start) ? match.start : 0,
            length: typeof match.length === 'number' && Number.isFinite(match.length) ? match.length : 0,
            snippet: match.snippet,
          };
        })
        .filter((match): match is CanvasNodeMatch => match !== undefined)
        .map((match) => ({ ...match, nodeId: raw.nodeId as string }))
    : [];
  return {
    nodeId: raw.nodeId,
    nodeType: typeof raw.nodeType === 'string' ? raw.nodeType : '',
    nodeStatus: typeof raw.nodeStatus === 'string' ? raw.nodeStatus : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    matches,
  };
}

/**
 * Coerce the optional `search` block. A reply that carries no `search` key (every
 * unfiltered GET) stays without one, so a caller can tell "no search was run"
 * apart from "the search found nothing".
 */
export function coerceCanvasGraphSearch(value: unknown): CanvasGraphSearch | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.query !== 'string') return undefined;
  return {
    query: raw.query,
    hits: Array.isArray(raw.hits)
      ? raw.hits.map(coerceCanvasSearchHit).filter((hit): hit is CanvasSearchHit => hit !== undefined)
      : [],
  };
}

/** Coerce the server's GET reply; undefined when the payload cannot be used. */
export function coerceCanvasGraphResponse(value: unknown): CanvasGraphResponse | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string') return undefined;
  const layout = coerceCanvasLayout(raw);
  if (!layout) return undefined;
  // A run with no graph carries no stats; count what is there so the reply is
  // always a usable layout rather than a missing field.
  const stats = layout.stats ?? {
    totalNodes: layout.nodes.length,
    nodesByType: countBy(layout.nodes, (node) => node.type),
    nodesByStatus: countBy(layout.nodes, (node) => node.status),
    depth: layout.nodes.reduce((max, node) => Math.max(max, node.depth), 0),
    edges: layout.edges.length,
  };
  const fresh = Array.isArray(raw.fresh)
    ? raw.fresh.map(coerceCanvasNode).filter((n): n is CanvasNode => n !== undefined)
    : [];
  // The search block is optional and must survive coercion: it is the only way a
  // client that holds a partial graph learns which nodes matched a `?q=` scan.
  const search = coerceCanvasGraphSearch((raw as { search?: unknown }).search);
  return {
    runId: raw.runId,
    enabled: raw.enabled !== false,
    nodes: layout.nodes,
    edges: layout.edges,
    stats,
    fresh,
    ...(search ? { search } : {}),
  };
}
