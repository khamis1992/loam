'use client';

/**
 * Neo N2: the Canvas panel.
 *
 * This is the Workspace editor for the `canvas` kind. It renders the run graph
 * (N1) as a pan/zoom surface: nodes as cards, edges as connectors, an Organize
 * button that re-lays the graph out so no two nodes overlap, an E shortcut that
 * opens the node detail, live updates from the server's graph stream, and the
 * Recipe side panel listing the agent's steps.
 *
 * Everything user-visible goes through `t()`, and every container uses logical
 * CSS (`border-s`, `ms-`/`me-`, `ps-`/`pe-`) so the panel reads correctly under
 * `dir="rtl"`. The canvas surface itself is `dir="ltr"` because its geometry is
 * graph space, not text flow.
 */
import { Keyboard, Loader2, Maximize2, Minus, Plus, Waypoints, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLocale, setLocale as syncDocumentLocale, t } from '@/i18n/t';
import type { ChatEvent } from '@shared/socket';
import { Check, Copy, Link2, Quote, Scissors, XCircle } from 'lucide-react';
import {
  type CanvasEdge,
  type CanvasLayoutNode,
  type CanvasNode,
  type CanvasNodePatch,
  type CanvasOpRequest,
  type CanvasOpResult,
  type CanvasStats,
} from './types';
import { applyLayout, layoutBounds, screenToGraph, type LayoutOptions } from './layout';
import { CanvasClient, type CanvasClientOptions } from './client';
import { CanvasStream, type CanvasStreamChange, type CanvasStreamHandlers } from './stream';
import {
  editableFields,
  excerpt,
  hasNodeText,
  isStale,
  nodeText,
  readEditHistory,
  withEditedText,
} from './nodeText';

/** Panel geometry. Graph space, not direction-aware: the canvas is transform-based. */
const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const SCALE_STEP = 1.2;
/** Poll cadence used when the live stream is not connected. */
const POLL_INTERVAL_MS = 5_000;
/** How often the panel mirrors an injected stream's running state. */
const LIVE_POLL_MS = 200;
/** A node id is a local run-graph id, so this is only a sanity bound on a selection. */
const MAX_SELECTION = 64;
/** A node card is too narrow for the whole edit history; the sheet shows the tail. */
const EDIT_HISTORY_ROWS = 6;

export interface CanvasPanelProps {
  taskId: string;
  /** The task is running, so the canvas keeps following the graph. */
  live: boolean;
  /** Chat events, used for the Recipe side panel and the node detail. */
  events?: ChatEvent[];
  /** Injectable client (tests). */
  client?: CanvasClient;
  /** Injectable stream (tests). */
  stream?: CanvasStream;
  /** Injectable layout options (tests). */
  layoutOptions?: LayoutOptions;
  /** Injectable locale provider (tests). */
  getLocale?: () => typeof getLocale extends () => infer L ? L : never;
}

interface ViewTransform {
  panX: number;
  panY: number;
  scale: number;
}

interface DragState {
  nodeId: string;
  /** Graph-space pointer position when the drag began. */
  startX: number;
  startY: number;
  /** Node position when the drag began. */
  fromX: number;
  fromY: number;
}

interface PanState {
  x: number;
  y: number;
  panX: number;
  panY: number;
}

/** The fields a node title is read from, most specific first. */
const TITLE_KEYS = ['title', 'model', 'query', 'url', 'path', 'summary', 'reason', 'message', 'verdict', 'tool', 'stepId'] as const;
const SUBTITLE_KEYS = ['answer', 'path', 'url'] as const;

function readString(data: unknown, keys: readonly string[]): string {
  if (typeof data !== 'object' || data === null) return '';
  const record = data as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Human title for a node, falling back to its type when the payload has none. */
function nodeTitle(node: CanvasLayoutNode, tr: (key: string) => string): string {
  return readString(node.data, TITLE_KEYS) || tr(NODE_TYPE_KEYS[node.type] ?? node.type);
}

/** Second line of a node card: the file or page it points at, else its status. */
function nodeSubtitle(node: CanvasLayoutNode, tr: (key: string) => string): string {
  return readString(node.data, SUBTITLE_KEYS) || tr(NODE_STATUS_KEYS[node.status] ?? node.status);
}

/** Node type labels are translated, so the canvas never hard-codes one. */
const NODE_TYPE_KEYS: Record<string, string> = {
  question: 'Question',
  recipe_step: 'Recipe step',
  search: 'Search',
  document: 'Document',
  webpage: 'Webpage',
  media: 'Media',
  ask_user: 'Waiting for you',
  complete: 'Completed',
  sibling: 'Model arm',
  branch: 'Branch',
  merge: 'Merged',
  note: 'Note',
  failed: 'Failed',
};

const NODE_STATUS_KEYS: Record<string, string> = {
  init: 'Not started',
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Merge fresh/updated nodes over a snapshot without dropping hand-placed ones. */
function mergeNodes(
  current: CanvasLayoutNode[],
  updates: CanvasNode[],
  layout: ReturnType<typeof applyLayout>,
): CanvasLayoutNode[] {
  if (updates.length === 0) return current;
  const byId = new Map(current.map((node) => [node.id, node]));
  for (const node of updates) {
    const placed = layout.find((entry) => entry.id === node.id);
    const previous = byId.get(node.id);
    // Keep the position the user already moved the node to.
    byId.set(node.id, {
      ...node,
      x: previous ? previous.x : (placed?.x ?? 0),
      y: previous ? previous.y : (placed?.y ?? 0),
      depth: previous ? previous.depth : (placed?.depth ?? 0),
    });
  }
  return [...byId.values()];
}

/** Highest event sequence the panel has rendered, used as the `afterSeq` cursor. */
function maxPosition(nodes: CanvasLayoutNode[]): number {
  return nodes.reduce((max, node) => Math.max(max, node.position ?? 0), 0);
}

export function CanvasPanel({
  taskId,
  live,
  events = [],
  client,
  stream,
  layoutOptions,
  getLocale: localeProvider,
}: CanvasPanelProps) {
  const [nodes, setNodes] = useState<CanvasLayoutNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [stats, setStats] = useState<CanvasStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewTransform>({ panX: 0, panY: 0, scale: 1 });
  const [liveConnected, setLiveConnected] = useState(false);
  // N11: which nodes the user has ticked for a group/branch/quote, and which were
  // superseded by an edit. Selection is a set of ids so a click never needs the
  // card to be in any particular render order.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [staleIds, setStaleIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'follow-up' | 'quote'>('follow-up');

  const apiRef = useRef<CanvasClient | null>(null);
  const streamRef = useRef<CanvasStream | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<CanvasLayoutNode[]>([]);
  const cursorRef = useRef(0);
  const selectionRef = useRef<string[]>([]);

  nodesRef.current = nodes;
  selectionRef.current = selectedIds;

  const locale = localeProvider ? localeProvider() : getLocale();
  const isRtl = locale === 'ar';

  /** Translate with this panel's locale, so a locale change needs no global state. */
  const tr = useCallback((key: string) => t(key, {}, locale), [locale]);

  // The panel lays itself out with logical CSS (`border-s`, `ms-`/`me-`), so the
  // document direction has to follow the locale the panel renders in. An
  // injected provider is a test seam: it must not rewrite the real document.
  useEffect(() => {
    if (localeProvider) return;
    syncDocumentLocale(locale);
  }, [locale, localeProvider]);

  // The client is built once; tests inject their own.
  useEffect(() => {
    if (client) {
      apiRef.current = client;
      return;
    }
    const options: CanvasClientOptions = {};
    apiRef.current = new CanvasClient(options);
  }, [client]);

  /** Re-run the layered layout over the current nodes (the "Organize" action). */
  const organize = useCallback(
    (list: CanvasLayoutNode[]) => {
      const placed = applyLayout(list, layoutOptions);
      setNodes((prev) =>
        prev.map((node) => {
          const match = placed.find((entry) => entry.id === node.id);
          return match ? { ...node, x: match.x, y: match.y, depth: match.depth } : node;
        }),
      );
    },
    [layoutOptions],
  );

  const loadInitial = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      const graph = await api.getGraph(taskId);
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setStats(graph.stats);
      cursorRef.current = maxPosition(graph.nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // A delta from the live stream: refetch from the change's cursor and lay in
  // only the nodes that are new, so the snapshot the user arranged is preserved.
  const applyChange = useCallback(
    async (change: CanvasStreamChange) => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const graph = await api.getGraph(taskId, change.seq);
        const layout = applyLayout(graph.nodes, layoutOptions);
        setNodes((prev) => mergeNodes(prev, graph.fresh, layout));
        setEdges(graph.edges);
        setStats(graph.stats);
        cursorRef.current = Math.max(cursorRef.current, change.seq);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [layoutOptions, taskId],
  );

  // Live subscription: the stream pushes a snapshot then a change per graph
  // update. Polling is the fallback for a server that does not stream.
  useEffect(() => {
    const handlers: CanvasStreamHandlers = {
      onSnapshot: (snapshot) => {
        const layoutNodes = (snapshot.nodes as CanvasLayoutNode[]) ?? [];
        setNodes(layoutNodes);
        setEdges((snapshot.edges as CanvasEdge[]) ?? []);
        setStats((snapshot.stats as CanvasStats) ?? null);
        cursorRef.current = maxPosition(layoutNodes);
        setLiveConnected(true);
      },
      onChange: (change) => {
        setLiveConnected(true);
        void applyChange(change);
      },
      onError: () => setLiveConnected(false),
    };
    // An injected stream has no way to tell the panel when it connects, so the
    // panel follows `isRunning()` itself. A stream the panel built reports
    // through the handlers instead, which is why those are only read then.
    const injected = stream != null;
    const active =
      stream ??
      (streamRef.current ??
        (streamRef.current = new CanvasStream({ runId: taskId, handlers })));
    if (!injected) {
      // The panel owns the handlers, so a stream it built still receives updates.
      active.setHandlers(handlers);
    }

    void loadInitial();
    void active.start();
    if (injected) setLiveConnected(active.isRunning());

    const poll = live
      ? setInterval(() => {
          if (!active.isRunning()) {
            void applyChange({ type: 'change', runId: taskId, nodeIds: [], seq: cursorRef.current });
          }
        }, POLL_INTERVAL_MS)
      : null;
    const follow = injected
      ? setInterval(() => setLiveConnected(active.isRunning()), LIVE_POLL_MS)
      : null;

    return () => {
      if (poll) clearInterval(poll);
      if (follow) clearInterval(follow);
      if (!stream) {
        active.stop();
        streamRef.current = null;
      }
    };
  }, [applyChange, live, loadInitial, stream, taskId]);

  // Keyboard: E opens the newest node, Escape closes it, +/- zoom.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Escape') {
        setExpandedId(null);
        return;
      }
      if (event.key === 'e' || event.key === 'E') {
        const list = nodesRef.current;
        if (list.length > 0) setExpandedId(list[list.length - 1]!.id);
        return;
      }
      if (event.key === '+' || event.key === '=') {
        zoomBy(SCALE_STEP);
        return;
      }
      if (event.key === '-' || event.key === '_') zoomBy(1 / SCALE_STEP);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setView((prev) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
      return { ...prev, scale };
    });
  }, []);

  const resetView = useCallback(() => {
    setView({ panX: 0, panY: 0, scale: 1 });
  }, []);

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    // Scrolling down (positive delta) means "zoom out", like every map canvas.
    const factor = event.deltaY > 0 ? 1 / SCALE_STEP : SCALE_STEP;
    setView((prev) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
      // Keep the point under the cursor stationary while zooming.
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return { ...prev, scale };
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      return {
        scale,
        panX: cursorX - ((cursorX - prev.panX) / prev.scale) * scale,
        panY: cursorY - ((cursorY - prev.panY) / prev.scale) * scale,
      };
    });
  }, []);

  const beginPan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      panRef.current = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY };
    },
    [view.panX, view.panY],
  );

  const movePan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setView((prev) => ({ ...prev, panX: pan.panX + (event.clientX - pan.x), panY: pan.panY + (event.clientY - pan.y) }));
  }, []);

  const endPan = useCallback(() => {
    panRef.current = null;
  }, []);

  const beginNodeDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, node: CanvasLayoutNode) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = screenToGraph({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
      dragRef.current = { nodeId: node.id, startX: point.x, startY: point.y, fromX: node.x, fromY: node.y };
    },
    [view],
  );

  const moveNodeDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = screenToGraph({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      setNodes((prev) =>
        prev.map((node) =>
          node.id === drag.nodeId ? { ...node, x: Math.round(drag.fromX + dx), y: Math.round(drag.fromY + dy) } : node,
        ),
      );
    },
    [view],
  );

  const endNodeDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const bounds = useMemo(() => layoutBounds(nodes), [nodes]);
  const expanded = useMemo(() => nodes.find((node) => node.id === expandedId) ?? null, [expandedId, nodes]);

  /** The Recipe panel: the plan's steps, in the order the agent emitted them. */
  const recipe = useMemo(() => nodes.filter((node) => node.type === 'recipe_step'), [nodes]);

  /**
   * N11: apply one editing operation and lay the reply back over the canvas.
   *
   * The server returns the whole graph because a duplicate, a group and a
   * re-connect all change structure, not just one field. Hand-placed positions are
   * preserved by merging on id, and the stale marks are *kept* even when a reply
   * carries no node for them: the agent only re-runs a node on the live path, so a
   * mark that vanished with its node would silently clear the "re-check this" flag
   * the user was shown.
   */
  const applyOp = useCallback(
    async (op: CanvasOpRequest) => {
      const api = apiRef.current;
      if (!api || busy) return;
      setBusy(true);
      try {
        const result: CanvasOpResult = await api.applyOp(taskId, op);
        setNodes((prev) => {
          const placed = applyLayout(result.nodes, layoutOptions);
          const byId = new Map(prev.map((node) => [node.id, node]));
          for (const node of result.nodes) {
            const previous = byId.get(node.id);
            const match = placed.find((entry) => entry.id === node.id);
            byId.set(node.id, {
              ...node,
              x: previous ? previous.x : (match?.x ?? 0),
              y: previous ? previous.y : (match?.y ?? 0),
              depth: previous ? previous.depth : (match?.depth ?? 0),
            });
          }
          return [...byId.values()];
        });
        setEdges(result.edges);
        setStats(result.stats);
        if (result.stale.length > 0) setStaleIds((prev) => [...new Set([...prev, ...result.stale])]);
        cursorRef.current = Math.max(cursorRef.current, maxPosition(result.nodes));
        if (op.op === 'group') setSelectedIds([]);
        if (op.op === 'duplicate') setExpandedId(result.nodeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, layoutOptions, taskId],
  );

  /** Tick a node for a multi-select action. */
  const toggleSelect = useCallback((nodeId: string) => {
    setSelectedIds((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : prev.length >= MAX_SELECTION ? prev : [...prev, nodeId],
    );
  }, []);

  /** Replace a stale mark: a re-run superseded it, so it is current again. */
  const clearStale = useCallback((nodeId: string) => {
    setStaleIds((prev) => prev.filter((id) => id !== nodeId));
  }, []);

  // A node that reappears with no `stale` payload is current again, so the flag is
  // cleared on the live path rather than only by hand. A mark with no node at all is
  // kept: see `applyOp`.
  useEffect(() => {
    setStaleIds((prev) =>
      prev.filter((id) => {
        const node = nodes.find((candidate) => candidate.id === id);
        return node ? isStale(node.data) : true;
      }),
    );
  }, [nodes]);

  // Editing operations act on the selected nodes, so they are disabled until there
  // is something to act on. This is what makes the empty-canvas state honest.
  const selection = useMemo(() => nodes.filter((node) => selectedIds.includes(node.id)), [nodes, selectedIds]);
  const primary = selection[0] ?? null;
  const canGroup = selection.length >= 2;

  /** Cut every edge into `node` (detach it from its parents). */
  const cutEdges = useCallback(
    (node: CanvasLayoutNode) => void applyOp({ op: 'cut', nodeId: node.id, parentIds: [] }),
    [applyOp],
  );

  /**
   * Connect `node` to the nodes the user has selected.
   *
   * A re-connect replaces the parent set, which is what "change the next step's
   * context" means: the node keeps its own content and its own history, and only
   * which nodes feed it changes.
   */
  const reconnectToSelection = useCallback(() => {
    if (!primary) return;
    // The node being re-pointed is not its own new parent; the server refuses a
    // self-parent, and "connect this node to the selected nodes" means the others.
    const parents = selection.filter((node) => node.id !== primary.id).map((node) => node.id);
    void applyOp({ op: 'reconnect', nodeId: primary.id, parentIds: parents });
    setSelectedIds([]);
  }, [applyOp, primary, selection]);

  /** Duplicate the node as an independent branch. */
  const branch = useCallback(
    (node: CanvasLayoutNode) => void applyOp({ op: 'duplicate', nodeId: node.id }),
    [applyOp],
  );

  /** Merge the selection into one context block. */
  const group = useCallback(() => {
    if (!canGroup) return;
    void applyOp({ op: 'group', nodeIds: selection.map((node) => node.id) });
  }, [applyOp, canGroup, selection]);

  /** Hand the node to the model as something to build on, or to reproduce. */
  const send = useCallback(() => {
    if (!primary) return;
    void applyOp({ op: mode === 'quote' ? 'quote' : 'follow-up', nodeId: primary.id });
  }, [applyOp, mode, primary]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary" data-testid="canvas-loading">
        <Loader2 className="size-4 animate-spin" />
        {tr('Loading')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-menu" data-testid="canvas-panel" data-live={liveConnected}>
      <div className="flex h-row-sm shrink-0 items-center gap-1 border-b border-border-main px-2">
        <button
          type="button"
          onClick={() => organize(nodes)}
          disabled={nodes.length === 0}
          title={tr('Organize the canvas')}
          className="flex items-center gap-1 rounded-control px-2 py-1 text-xs text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
        >
          <Waypoints className="size-3.5" />
          {tr('Organize')}
        </button>
        <button
          type="button"
          onClick={() => zoomBy(SCALE_STEP)}
          title={tr('Zoom in')}
          aria-label={tr('Zoom in')}
          className="rounded-control p-1 text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <Plus className="size-3.5" />
        </button>
        <span className="w-10 text-center text-[11px] tabular-nums text-text-tertiary" data-testid="canvas-zoom">
          {Math.round(view.scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(1 / SCALE_STEP)}
          title={tr('Zoom out')}
          aria-label={tr('Zoom out')}
          className="rounded-control p-1 text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <Minus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={resetView}
          title={tr('Reset the view')}
          aria-label={tr('Reset the view')}
          className="rounded-control p-1 text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <Maximize2 className="size-3.5" />
        </button>
        <span className="ms-auto flex items-center gap-1 text-[11px] text-text-tertiary" data-testid="canvas-live">
          <span
            className={liveConnected ? 'size-1.5 rounded-full bg-icon-blue' : 'size-1.5 rounded-full bg-text-quaternary'}
          />
          {liveConnected ? tr('Live') : tr('Paused')}
        </span>
      </div>

      {nodes.length > 0 ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-main px-2 py-1"
          data-testid="canvas-selection"
        >
          <span className="text-[11px] text-text-tertiary" data-testid="canvas-selection-count">
            {t('{count} selected', { count: selectedIds.length }, locale)}
          </span>
          <button
            type="button"
            onClick={reconnectToSelection}
            disabled={busy || !primary}
            title={tr('Reconnect this node to the selected nodes')}
            className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
          >
            <Link2 className="size-3" />
            {tr('Reconnect')}
          </button>
          <button
            type="button"
            onClick={group}
            disabled={busy || !canGroup}
            title={tr('Group the selected nodes')}
            className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
          >
            <Check className="size-3" />
            {tr('Group')}
          </button>
          <button
            type="button"
            onClick={() => primary && branch(primary)}
            disabled={busy || !primary}
            title={tr('Branch this node')}
            className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
          >
            <Copy className="size-3" />
            {tr('Branch')}
          </button>
          <div className="flex items-center gap-1 rounded-control border border-border-main px-1">
            {(['follow-up', 'quote'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                data-testid={`canvas-mode-${value}`}
                className={[
                  'rounded px-1.5 py-0.5 text-[11px]',
                  mode === value ? 'bg-fill-tsp text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
                ].join(' ')}
              >
                {value === 'quote' ? tr('Quote') : tr('Follow up')}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={send}
            disabled={busy || !primary}
            data-testid="canvas-send"
            title={tr('Ask the agent to continue from this node')}
            className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
          >
            <Quote className="size-3" />
            {mode === 'quote' ? tr('Quote') : tr('Follow up')}
          </button>
          <button
            type="button"
            onClick={() => primary && cutEdges(primary)}
            disabled={busy || !primary}
            title={tr('Cut edge from this node')}
            className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
          >
            <Scissors className="size-3" />
            {tr('Cut edge')}
          </button>
          {staleIds.length > 0 ? (
            <span
              className="ms-auto flex items-center gap-1 text-[11px] text-function-warning"
              data-testid="canvas-stale-count"
            >
              <XCircle className="size-3" />
              {t('{count} stale', { count: staleIds.length }, locale)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div
          ref={surfaceRef}
          className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
          data-testid="canvas-surface"
          // Graph space is left-to-right by definition; only the chrome around it
          // follows the document direction.
          dir="ltr"
          onWheel={onWheel}
          onPointerDown={beginPan}
          onPointerMove={(event) => {
            if (dragRef.current) moveNodeDrag(event);
            else movePan(event);
          }}
          onPointerUp={() => {
            endNodeDrag();
            endPan();
          }}
          onPointerLeave={() => {
            endNodeDrag();
            endPan();
          }}
        >
          <svg
            className="pointer-events-none absolute"
            width={Math.max(bounds.width + NODE_WIDTH + 80, 1)}
            height={Math.max(bounds.height + NODE_HEIGHT + 80, 1)}
            style={{
              transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.scale})`,
              transformOrigin: '0 0',
            }}
            data-testid="canvas-edges"
          >
            {edges.map((edge) => {
              const from = nodes.find((node) => node.id === edge.from);
              const to = nodes.find((node) => node.id === edge.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_WIDTH / 2;
              const y1 = from.y + NODE_HEIGHT;
              const x2 = to.x + NODE_WIDTH / 2;
              const y2 = to.y;
              const midY = (y1 + y2) / 2;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--border-main)"
                  strokeWidth={1.5 / view.scale}
                />
              );
            })}
          </svg>

          {nodes.map((node) => (
            <div
              key={node.id}
              onPointerDown={(event) => beginNodeDrag(event, node)}
              data-testid="canvas-node"
              data-node-id={node.id}
              data-node-type={node.type}
              data-node-status={node.status}
              data-selected={selectedIds.includes(node.id) ? 'true' : 'false'}
              data-stale={isStale(node.data) ? 'true' : 'false'}
              role="group"
              aria-label={nodeTitle(node, tr)}
              className="absolute flex flex-col gap-1"
              style={{
                width: NODE_WIDTH,
                minHeight: NODE_HEIGHT,
                // Nodes keep their own size at every zoom level: only the
                // transform scales, so a zoomed-out card stays readable.
                transform: `translate(${view.panX + node.x * view.scale}px, ${view.panY + node.y * view.scale}px)`,
              }}
            >
              {/*
                A card is a `group` rather than a button because it holds two
                controls: the tick that selects it for a group or a re-connect, and
                the card itself that opens the detail sheet. Nesting the tick in the
                card would make every click select, which is the opposite of what a
                user means by "open this node".
              */}
              <div className="flex items-center gap-1 text-[10px] text-text-tertiary">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(node.id)}
                  onChange={() => toggleSelect(node.id)}
                  onClick={(event) => event.stopPropagation()}
                  data-testid="canvas-node-select"
                  aria-label={tr('Select')}
                  className="size-3 shrink-0 accent-icon-blue"
                />
                <span>
                  {tr(NODE_TYPE_KEYS[node.type] ?? node.type)} · {tr(NODE_STATUS_KEYS[node.status] ?? node.status)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setExpandedId(node.id === expandedId ? null : node.id)}
                aria-label={nodeTitle(node, tr)}
                aria-pressed={node.id === expandedId}
                className={[
                  'flex flex-col gap-1 rounded-card border p-2 text-start',
                  selectedIds.includes(node.id)
                    ? 'border-icon-blue bg-fill-tsp text-text-primary shadow-sm'
                    : 'border-border-main bg-bg-menu text-text-primary shadow-sm',
                  node.id === expandedId ? 'border-icon-blue' : 'hover:border-border-dark',
                ].join(' ')}
              >
                <span className="truncate text-[11px] text-text-secondary">{nodeTitle(node, tr)}</span>
                <span dir="auto" className="truncate text-[10px] text-text-tertiary">
                  {nodeSubtitle(node, tr)}
                </span>
                {isStale(node.data) ? (
                  <span
                    className="mt-auto text-[10px] text-function-warning"
                    data-testid="canvas-node-stale"
                    data-node-id={node.id}
                  >
                    {tr('Stale')}
                  </span>
                ) : null}
              </button>
            </div>
          ))}

          {nodes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <Waypoints className="size-8 text-text-quaternary" />
              <p className="text-sm text-text-tertiary" data-testid="canvas-empty">
                {tr('The canvas is empty. Nodes appear here as the task runs.')}
              </p>
            </div>
          )}
        </div>

        <aside
          className="flex w-[260px] shrink-0 flex-col border-s border-border-main"
          data-testid="canvas-recipe"
        >
          <div className="flex h-row-sm shrink-0 items-center gap-1 border-b border-border-main px-2 text-xs text-text-secondary">
            <Keyboard className="size-3.5" />
            <span className="truncate">{tr('Recipe')}</span>
            {stats ? (
              <span className="ms-auto text-[11px] text-text-tertiary" data-testid="canvas-stats">
                {stats.totalNodes} {tr('nodes')}
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {recipe.length === 0 ? (
              <p className="text-xs text-text-tertiary">{tr('No recipe steps yet.')}</p>
            ) : (
              <ol className="flex flex-col gap-1">
                {recipe.map((step, index) => (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => setExpandedId(step.id)}
                      className="flex w-full items-start gap-1.5 rounded-control px-1.5 py-1 text-start text-xs hover:bg-fill-hover"
                    >
                      <span
                        className={
                          step.status === 'finished'
                            ? 'text-func-success'
                            : step.status === 'failed'
                              ? 'text-func-error'
                              : 'text-icon-blue'
                        }
                      >
                        {step.status === 'finished' ? '✓' : step.status === 'running' ? '◉' : '○'}
                      </span>
                      <span
                        dir="auto"
                        className={step.status === 'finished' ? 'text-text-tertiary line-through' : 'text-text-secondary'}
                      >
                        {index + 1}. {nodeTitle(step, tr)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>

      {error ? (
        <div
          className="shrink-0 border-t border-border-main bg-function-warning-tsp px-2 py-1 text-[11px] text-function-warning"
          data-testid="canvas-error"
        >
          {tr('The canvas could not reach the task.')} {error}
        </div>
      ) : null}

      {expanded ? (
        <NodeDetail
          node={expanded}
          events={events}
          isRtl={isRtl}
          tr={tr}
          onClose={() => setExpandedId(null)}
          onEdit={(text) => void applyOp({ op: 'edit', nodeId: expanded.id, text, mode })}
          onCut={() => cutEdges(expanded)}
          onBranch={() => branch(expanded)}
          stale={staleIds.includes(expanded.id) || isStale(expanded.data)}
          canEdit={hasNodeText(expanded)}
        />
      ) : null}
    </div>
  );
}

/** The node detail sheet, opened by the E shortcut or a click. */
function NodeDetail({
  node,
  events,
  isRtl,
  tr,
  onClose,
  onEdit,
  onCut,
  onBranch,
  stale,
  canEdit,
}: {
  node: CanvasLayoutNode;
  events: ChatEvent[];
  isRtl: boolean;
  tr: (key: string) => string;
  onClose: () => void;
  /** The N11 edit: version the node and mark what it supersedes. */
  onEdit: (text: string) => void;
  /** Cut every edge into this node. */
  onCut: () => void;
  /** Duplicate this node as a branch. */
  onBranch: () => void;
  /** True when the node was superseded by an edit to an earlier node. */
  stale: boolean;
  /** False when the node carries no prose worth editing. */
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<string>(() => readString(node.data, TITLE_KEYS));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const editable = editableFields(node.data);
  const editKey = Object.keys(editable)[0];
  const history = readEditHistory(node.data);
  const edits = history.slice(-EDIT_HISTORY_ROWS);

  // The sheet is opened per node, so the draft follows whichever node it shows.
  useEffect(() => {
    setDraft(nodeText(node));
    setSaveError(null);
  }, [node]);

  const related = useMemo(
    () => events.filter((event) => event.type === 'toolUsed').slice(-5),
    [events],
  );

  /**
   * Saving here is an N11 *edit*: the node gets a new version, its old text is
   * kept in the history, and everything that depended on it is marked stale. It
   * goes through `applyOp` on purpose: a bare field PATCH would change the node
   * without versioning it or telling the agent, so the graph and the model would
   * disagree about the run.
   */
  const save = (): void => {
    const text = draft.trim();
    if (!text || text === nodeText(node)) return;
    setSaving(true);
    onEdit(text);
    setSaving(false);
  };

  /** The previous text of the latest edit, so the diff is visible without a modal. */
  const lastEdit = history.length > 0 ? history[history.length - 1]! : null;

  return (
    <aside
      className="flex max-h-[45%] w-full shrink-0 flex-col gap-2 border-t border-border-main bg-bg-menu p-3"
      data-testid="canvas-node-detail"
      data-node-id={node.id}
      data-version={node.version}
      data-stale={stale ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary" dir="auto">
            {nodeTitle(node, tr)}
          </p>
          <p className="text-[11px] text-text-tertiary">
            {tr(NODE_TYPE_KEYS[node.type] ?? node.type)} · {tr(NODE_STATUS_KEYS[node.status] ?? node.status)} · v
            {node.version}
          </p>
          {stale ? (
            <p className="text-[11px] text-function-warning" data-testid="canvas-node-stale">
              {tr('Stale: superseded by an edit to an earlier node')}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('Close')}
          className="rounded-control p-1 text-text-secondary hover:bg-fill-hover"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onCut}
          data-testid="canvas-sheet-cut"
          title={tr('Cut edge from this node')}
          className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <Scissors className="size-3" />
          {tr('Cut edge')}
        </button>
        <button
          type="button"
          onClick={onBranch}
          title={tr('Branch this node')}
          className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <Copy className="size-3" />
          {tr('Branch')}
        </button>
        {isRtl ? <span className="ms-auto text-[11px] text-text-tertiary">{tr('RTL')}</span> : null}
      </div>

      <label className="text-[11px] text-text-tertiary" htmlFor="canvas-node-edit">
        {tr('Edit this node')}
        {editKey ? ` (${editKey})` : ''}
      </label>
      <textarea
        id="canvas-node-edit"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        dir="auto"
        disabled={!canEdit}
        placeholder={tr('No text to edit on this node.')}
        className="w-full resize-y rounded-control border border-border-main bg-bg-main p-2 text-xs text-text-primary outline-none focus:border-icon-blue disabled:opacity-50"
        aria-label={tr('Edit this node')}
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !canEdit || draft.trim() === nodeText(node)}
          className="rounded-control bg-fill-tsp px-2 py-1 text-xs font-medium text-text-primary hover:bg-fill-hover disabled:opacity-50"
        >
          {saving ? tr('Saving') : tr('Save')}
        </button>
        {saveError ? <span className="text-[11px] text-func-error">{saveError}</span> : null}
      </div>

      {history.length > 0 ? (
        <div className="min-h-0 overflow-y-auto">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            className="text-[11px] text-text-tertiary underline decoration-dotted"
          >
            {tr('Edit history')} ({history.length})
          </button>
          {historyOpen ? (
            <ol className="mt-1 flex flex-col gap-1" data-testid="canvas-edit-history">
              {edits.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="text-[11px] text-text-secondary">
                  <span className="text-text-tertiary">{tr('Previous text')}:</span>{' '}
                  <span dir="auto">{entry.previous || '—'}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      {lastEdit && !historyOpen ? (
        <p className="truncate text-[11px] text-text-tertiary" dir="auto">
          <span className="text-text-quaternary">{tr('Previous text')}:</span> {excerpt(lastEdit.previous, 80)}
        </p>
      ) : null}

      {related.length > 0 ? (
        <div className="min-h-0 overflow-y-auto">
          <p className="mb-1 text-[11px] text-text-tertiary">{tr('Recent tools')}</p>
          <ul className="flex flex-col gap-1">
            {related.map((event) => (
              <li key={event.id} className="truncate text-[11px] text-text-secondary" dir="auto">
                {event.type === 'toolUsed' ? event.tool : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

export default CanvasPanel;
