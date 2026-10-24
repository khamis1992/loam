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
 * Neo N18 adds the user's own layer over that graph: colour tags, per-node comment
 * threads, free notes on the surface, a search box that highlights the nodes it
 * matched, a minimap and a keyboard-shortcut sheet. Annotations live on the server
 * (`CanvasAnnotationsClient`), never inside the graph, so the agent's run record
 * stays exactly what the agent wrote.
 *
 * Search runs over the nodes the panel already holds, through the same pure
 * function the server uses for `?q=` (`./search` mirrors `src/graph/search.ts`).
 * That is one render instead of a round trip; the server route serves clients
 * that do not keep the whole run.
 *
 * Everything user-visible goes through `t()`, and every container uses logical
 * CSS (`border-s`, `ms-`/`me-`, `ps-`/`pe-`) so the panel reads correctly under
 * `dir="rtl"`. The canvas surface itself is `dir="ltr"` because its geometry is
 * graph space, not text flow.
 */
import {
  Download,
  HelpCircle,
  Keyboard,
  Loader2,
  Maximize2,
  MessageSquare,
  Minus,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLocale, setLocale as syncDocumentLocale, t, type Locale } from '@/i18n/t';
import type { ChatEvent } from '@shared/socket';
import {
  type CanvasEdge,
  type CanvasLayoutNode,
  type CanvasNode,
  type CanvasNodePatch,
  type CanvasStats,
} from './types';
import { applyLayout, layoutBounds, screenToGraph, type LayoutOptions } from './layout';
import { CanvasClient, type CanvasClientOptions } from './client';
import { CanvasStream, type CanvasStreamChange, type CanvasStreamHandlers } from './stream';
import { VersionPanel } from './VersionPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { WebpageActions } from './WebpageActions';
import { getLoamBase } from '@/services/rpc';
import {
  CANVAS_TAG_COLOUR_CSS,
  CANVAS_TAG_COLOURS,
  emptyCanvasAnnotations,
  type CanvasAnnotations,
  type CanvasComment,
  type CanvasFreeNote,
  type CanvasTagColour,
} from './types.annotations';
import { CanvasAnnotationsClient } from './annotationsClient';
import { searchCanvasNodes, searchMatches } from './search';
import { Minimap } from './Minimap';

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
/** Free-note card footprint in graph space. */
const NOTE_WIDTH = 200;
const NOTE_MIN_HEIGHT = 72;
/** Viewport size used before the surface has been measured (first paint, jsdom). */
const FALLBACK_SURFACE = { width: 900, height: 600 };
/** Where a note appears when the user adds one without pointing at a spot. */
const NOTE_SPAWN = { x: 120, y: 120 };

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
  /** Injectable annotation client (tests). */
  annotationsClient?: CanvasAnnotationsClient;
  /** Injectable layout options (tests). */
  layoutOptions?: LayoutOptions;
  /** Injectable locale provider (tests). */
  getLocale?: () => Locale;
  /** Injectable fetch, so the export button can be tested without a server. */
  fetchFn?: typeof fetch;
  /** Injectable API base; defaults to the Loam server base. */
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
  // N3: a cited Knowledge Garden seed, drawn as a document node.
  kb_seed: 'Knowledge seed',
};

const NODE_STATUS_KEYS: Record<string, string> = {
  init: 'Not started',
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Each tag colour's label. `none` is "no tag", which is a real choice, not a gap. */
const TAG_COLOUR_KEYS: Record<CanvasTagColour, string> = {
  none: 'None',
  blue: 'Blue',
  green: 'Green',
  amber: 'Amber',
  red: 'Red',
  violet: 'Violet',
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

/** File name for the exported replay, matching the server's convention. */
function replayFileName(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  return `loam-replay-${safe}.html`;
}

export function CanvasPanel({
  taskId,
  live,
  events = [],
  client,
  stream,
  annotationsClient,
  layoutOptions,
  getLocale: localeProvider,
  fetchFn,
  apiBase,
}: CanvasPanelProps) {
  const [nodes, setNodes] = useState<CanvasLayoutNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [stats, setStats] = useState<CanvasStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewTransform>({ panX: 0, panY: 0, scale: 1 });
  const [liveConnected, setLiveConnected] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [replayNotice, setReplayNotice] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<CanvasAnnotations>(() => emptyCanvasAnnotations(taskId));
  const [searchTerm, setSearchTerm] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [surfaceSize, setSurfaceSize] = useState(FALLBACK_SURFACE);

  const apiRef = useRef<CanvasClient | null>(null);
  const annotationsApiRef = useRef<CanvasAnnotationsClient | null>(null);
  const streamRef = useRef<CanvasStream | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const noteDragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<CanvasLayoutNode[]>([]);
  const cursorRef = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // The keyboard listener is registered once, so it reaches the newest note
  // creator through a ref instead of re-registering on every render.
  const addNoteRef = useRef<(position: { x: number; y: number }) => void>(() => {});
  // Read by the pointer-up handler, which runs outside React's render cycle.
  const annotationsRef = useRef(annotations);

  nodesRef.current = nodes;
  annotationsRef.current = annotations;

  const locale = localeProvider ? localeProvider() : getLocale();
  const isRtl = locale === 'ar';

  /**
   * Translate with this panel's locale, so a locale change needs no global
   * state. `vars` is threaded through because the node-action panels interpolate
   * counts and names ("{count} versions"), and a translator that dropped them
   * would print the placeholder instead of the number.
   */
  const tr = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(key, vars ?? {}, locale),
    [locale],
  );

  // A layer is read start-to-end, so Arabic lays a row out from the right. An
  // explicit `layoutOptions.direction` wins, so a test can pin either direction
  // without having to fake a locale.
  const layoutDirection = layoutOptions?.direction ?? (isRtl ? 'rtl' : 'ltr');
  const effectiveLayout = useMemo<LayoutOptions>(
    () => ({ ...layoutOptions, direction: layoutDirection }),
    [layoutOptions, layoutDirection],
  );

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

  // The annotation client is separate from the graph client: annotations are the
  // user's layer, and a server that does not serve them still serves the graph.
  useEffect(() => {
    const api = annotationsClient ?? new CanvasAnnotationsClient();
    annotationsApiRef.current = api;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.getAnnotations(taskId);
        if (!cancelled) setAnnotations(loaded);
      } catch (err) {
        // A run with no annotation layer yet is not an error the user must see;
        // an unreachable server is, and the graph fetch reports that separately.
        if (!cancelled) setAnnotations(emptyCanvasAnnotations(taskId));
        void err;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [annotationsClient, taskId]);

  /** Run one annotation edit, folding a failure into the panel's notice. */
  const withAnnotations = useCallback(
    async (run: (api: CanvasAnnotationsClient) => Promise<void>) => {
      const api = annotationsApiRef.current;
      if (!api) return;
      try {
        await run(api);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const setColour = useCallback(
    (nodeId: string, colour: CanvasTagColour) => {
      setAnnotations((prev) => {
        const tags = { ...prev.tags };
        if (colour === 'none') delete tags[nodeId];
        else tags[nodeId] = colour;
        return { ...prev, tags };
      });
      void withAnnotations((api) => api.setColour(taskId, nodeId, { colour }));
    },
    [taskId, withAnnotations],
  );

  const addComment = useCallback(
    (nodeId: string, text: string) => {
      void withAnnotations(async (api) => {
        const comment = await api.addComment(taskId, nodeId, { text });
        setAnnotations((prev) => ({
          ...prev,
          comments: { ...prev.comments, [nodeId]: [...(prev.comments[nodeId] ?? []), comment] },
        }));
      });
    },
    [taskId, withAnnotations],
  );

  const removeComment = useCallback(
    (nodeId: string, commentId: string) => {
      setAnnotations((prev) => {
        const thread = (prev.comments[nodeId] ?? []).filter((comment) => comment.id !== commentId);
        const comments = { ...prev.comments };
        if (thread.length === 0) delete comments[nodeId];
        else comments[nodeId] = thread;
        return { ...prev, comments };
      });
      void withAnnotations((api) => api.removeComment(taskId, nodeId, commentId));
    },
    [taskId, withAnnotations],
  );

  const addNote = useCallback(
    (position: { x: number; y: number }) => {
      void withAnnotations(async (api) => {
        const note = await api.addNote(taskId, { text: t('New note', {}, locale), x: position.x, y: position.y });
        setAnnotations((prev) => ({ ...prev, notes: [...prev.notes, note] }));
        setEditingNoteId(note.id);
      });
    },
    [locale, taskId, withAnnotations],
  );

  const updateNote = useCallback(
    (noteId: string, patch: { text?: string; x?: number; y?: number; colour?: CanvasTagColour }) => {
      setAnnotations((prev) => ({
        ...prev,
        notes: prev.notes.map((note) => (note.id === noteId ? { ...note, ...patch } : note)),
      }));
      void withAnnotations(async (api) => {
        const note = await api.updateNote(taskId, noteId, patch);
        setAnnotations((prev) => ({ ...prev, notes: prev.notes.map((entry) => (entry.id === noteId ? note : entry)) }));
      });
    },
    [taskId, withAnnotations],
  );

  const removeNote = useCallback(
    (noteId: string) => {
      setAnnotations((prev) => ({ ...prev, notes: prev.notes.filter((note) => note.id !== noteId) }));
      setEditingNoteId((prev) => (prev === noteId ? null : prev));
      void withAnnotations((api) => api.removeNote(taskId, noteId));
    },
    [taskId, withAnnotations],
  );

  addNoteRef.current = addNote;

  // The minimap needs the surface's pixel size to draw the viewport rectangle.
  // jsdom reports zeroes, so the fallback keeps the geometry finite in tests.
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const measure = (): void => {
      const width = element.clientWidth || FALLBACK_SURFACE.width;
      const height = element.clientHeight || FALLBACK_SURFACE.height;
      setSurfaceSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading]);

  /** Re-run the layered layout over the current nodes (the "Organize" action). */
  const organize = useCallback(
    (list: CanvasLayoutNode[]) => {
      const placed = applyLayout(list, effectiveLayout);
      setNodes((prev) =>
        prev.map((node) => {
          const match = placed.find((entry) => entry.id === node.id);
          return match ? { ...node, x: match.x, y: match.y, depth: match.depth } : node;
        }),
      );
    },
    [effectiveLayout],
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
        const layout = applyLayout(graph.nodes, effectiveLayout);
        setNodes((prev) => mergeNodes(prev, graph.fresh, layout));
        setEdges(graph.edges);
        setStats(graph.stats);
        cursorRef.current = Math.max(cursorRef.current, change.seq);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [effectiveLayout, taskId],
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

  // Keyboard: E opens the newest node, Escape closes, +/- zoom, S search, N note,
  // ? shortcuts. Typing in the search box or a comment must not fire these, which
  // is why the guard covers the whole handler rather than each binding.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        typeof (target as Element).getAttribute === 'function' &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.getAttribute('role') === 'textbox');
      if (event.key === 'Escape') {
        setExpandedId(null);
        setShortcutsOpen(false);
        setEditingNoteId(null);
        return;
      }
      if (typing) return;
      if (event.key === 'e' || event.key === 'E') {
        const list = nodesRef.current;
        if (list.length > 0) setExpandedId(list[list.length - 1]!.id);
        return;
      }
      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        void addNoteRef.current(NOTE_SPAWN);
        return;
      }
      if (event.key === '?') {
        setShortcutsOpen((prev) => !prev);
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

  /** Move a free note: the same drag maths as a node, on the note's own ref. */
  const beginNoteDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, note: CanvasFreeNote) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = screenToGraph({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
      noteDragRef.current = { nodeId: note.id, startX: point.x, startY: point.y, fromX: note.x, fromY: note.y };
    },
    [view],
  );

  const moveNoteDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = noteDragRef.current;
      if (!drag) return;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = screenToGraph({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
      const x = Math.round(drag.fromX + (point.x - drag.startX));
      const y = Math.round(drag.fromY + (point.y - drag.startY));
      setAnnotations((prev) => ({
        ...prev,
        notes: prev.notes.map((note) => (note.id === drag.nodeId ? { ...note, x, y } : note)),
      }));
    },
    [view],
  );

  const endNoteDrag = useCallback(() => {
    const drag = noteDragRef.current;
    noteDragRef.current = null;
    if (!drag) return;
    // The server is told once the drag ends, not on every pointer move: a note
    // move is one edit, and a burst of writes would fight the local position.
    const moved = annotationsRef.current.notes.find((note) => note.id === drag.nodeId);
    if (moved) {
      void withAnnotations(async (api) => {
        await api.updateNote(taskId, moved.id, { x: moved.x, y: moved.y });
      });
    }
  }, [taskId, withAnnotations]);

  const bounds = useMemo(() => layoutBounds(nodes), [nodes]);
  const expanded = useMemo(() => nodes.find((node) => node.id === expandedId) ?? null, [expandedId, nodes]);

  /** The Recipe panel: the plan's steps, in the order the agent emitted them. */
  const recipe = useMemo(() => nodes.filter((node) => node.type === 'recipe_step'), [nodes]);

  /**
   * The search results. The panel searches the nodes it holds, so a match is
   * available on the next render; `searchMatches` then drives the highlight ring
   * on the cards, the minimap dots and the result list.
   */
  const searchHits = useMemo(() => searchCanvasNodes(nodes, searchTerm), [nodes, searchTerm]);
  const matchedIds = useMemo(() => searchMatches(searchHits), [searchHits]);
  const searching = searchTerm.trim().length > 0;

  /**
   * The graph-space rectangle the viewport shows. It is the surface's pixel size
   * divided by the zoom, offset by the pan, so the minimap's rectangle and the
   * canvas always describe the same part of the run.
   */
  const viewport = useMemo(
    () => ({
      width: surfaceSize.width / view.scale,
      height: surfaceSize.height / view.scale,
      offsetX: -view.panX / view.scale,
      offsetY: -view.panY / view.scale,
    }),
    [surfaceSize.height, surfaceSize.width, view.panX, view.panY, view.scale],
  );

  /** A click on the minimap: move the viewport's centre to the graph point aimed at. */
  const navigateTo = useCallback((offset: { offsetX: number; offsetY: number }) => {
    setView((prev) => ({ ...prev, panX: -offset.offsetX * prev.scale, panY: -offset.offsetY * prev.scale }));
  }, []);

  const savePatch = useCallback(
    async (nodeId: string, patch: CanvasNodePatch) => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const updated = await api.patchNode(taskId, nodeId, patch);
        setNodes((prev) => prev.map((node) => (node.id === updated.id ? { ...node, ...updated } : node)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [taskId],
  );

  /**
   * Export the run as a self-contained replay. The server strips credentials
   * before it renders, so the artifact that lands on disk is safe to forward;
   * the canvas itself never gets to decide what is included. The response is
   * `inline` HTML, so this is a plain navigation and the user can save it with
   * the browser's own save action.
   */
  const exportReplay = useCallback(async () => {
    setExporting(true);
    setReplayNotice(null);
    try {
      const base = apiBase ?? getLoamBase();
      const res = await (fetchFn ?? fetch)(
        `${base}/api/graph/${encodeURIComponent(taskId)}/replay/html`,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = replayFileName(taskId);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setReplayNotice(tr('Replay exported'));
    } catch {
      setReplayNotice(tr('Replay export failed'));
    } finally {
      setExporting(false);
    }
  }, [apiBase, fetchFn, taskId, tr]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary" data-testid="canvas-loading">
        <Loader2 className="size-4 animate-spin" />
        {tr('Loading')}
      </div>
    );
  }

  return (
    // The panel is the positioning context: the shortcut sheet anchors to it,
    // so it cannot drift away from the canvas when the page scrolls.
    <div
      className="relative flex h-full min-h-0 flex-col bg-bg-menu"
      data-testid="canvas-panel"
      data-live={liveConnected}
    >
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
        <button
          type="button"
          onClick={() => void exportReplay()}
          disabled={exporting || nodes.length === 0}
          title={tr('Export replay')}
          className="flex items-center gap-1 rounded-control px-2 py-1 text-xs text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
        >
          <Download className="size-3.5" />
          {exporting ? tr('Exporting') : tr('Export replay')}
        </button>
        <button
          type="button"
          onClick={() => void addNote(NOTE_SPAWN)}
          title={tr('Add a note')}
          aria-label={tr('Add a note')}
          data-testid="canvas-add-note"
          className="rounded-control p-1 text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <StickyNote className="size-3.5" />
        </button>
        <div className="relative ms-1 flex items-center">
          <Search className="pointer-events-none absolute start-1.5 size-3.5 text-text-tertiary" />
          <input
            ref={searchRef}
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={tr('Search the canvas')}
            aria-label={tr('Search the canvas')}
            data-testid="canvas-search"
            dir="auto"
            className="w-44 rounded-control border border-border-main bg-bg-main py-1 pe-2 ps-6 text-xs text-text-primary outline-none focus:border-icon-blue"
          />
          {searching ? (
            <span className="ms-1 text-[11px] tabular-nums text-text-tertiary" data-testid="canvas-search-count">
              {searchHits.length}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setShortcutsOpen((prev) => !prev)}
          title={tr('Keyboard shortcuts')}
          aria-label={tr('Keyboard shortcuts')}
          aria-pressed={shortcutsOpen}
          data-testid="canvas-shortcuts-toggle"
          className="rounded-control p-1 text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <HelpCircle className="size-3.5" />
        </button>
        <span className="ms-auto flex items-center gap-1 text-[11px] text-text-tertiary" data-testid="canvas-live">
          <span
            className={liveConnected ? 'size-1.5 rounded-full bg-icon-blue' : 'size-1.5 rounded-full bg-text-quaternary'}
          />
          {liveConnected ? tr('Live') : tr('Paused')}
        </span>
      </div>

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
            if (noteDragRef.current) moveNoteDrag(event);
            else if (dragRef.current) moveNodeDrag(event);
            else movePan(event);
          }}
          onPointerUp={() => {
            endNoteDrag();
            endNodeDrag();
            endPan();
          }}
          onPointerLeave={() => {
            endNoteDrag();
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
            // The card is a `div`, not a `button`: its tag swatches and comment
            // count are controls, and a button may not contain another button.
            <div
              key={node.id}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => beginNodeDrag(event, node)}
              onClick={() => setExpandedId(node.id === expandedId ? null : node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setExpandedId(node.id === expandedId ? null : node.id);
                }
              }}
              data-testid="canvas-node"
              data-node-id={node.id}
              data-node-type={node.type}
              data-node-status={node.status}
              data-node-tag={annotations.tags[node.id] ?? 'none'}
              data-node-match={searching && matchedIds.has(node.id) ? 'true' : 'false'}
              data-node-comments={(annotations.comments[node.id] ?? []).length}
              aria-label={nodeTitle(node, tr)}
              className={[
                'absolute flex cursor-pointer flex-col gap-1 rounded-card border p-2 text-start',
                'border-border-main bg-bg-menu text-text-primary shadow-sm',
                node.id === expandedId ? 'border-icon-blue' : 'hover:border-border-dark',
              ].join(' ')}
              style={{
                width: NODE_WIDTH,
                minHeight: NODE_HEIGHT,
                // A colour tag and a search hit are drawn as a border, so neither
                // changes the card's size or the layout the user arranged.
                ...(annotations.tags[node.id] && annotations.tags[node.id] !== 'none'
                  ? { borderColor: CANVAS_TAG_COLOUR_CSS[annotations.tags[node.id]!] }
                  : {}),
                ...(searching && matchedIds.has(node.id)
                  ? { boxShadow: `0 0 0 2px ${CANVAS_TAG_COLOUR_CSS.blue}` }
                  : {}),
                // Nodes keep their own size at every zoom level: only the
                // transform scales, so a zoomed-out card stays readable.
                transform: `translate(${view.panX + node.x * view.scale}px, ${view.panY + node.y * view.scale}px)`,
              }}
            >
              <span className="flex items-center gap-1">
                <span className="truncate text-[11px] text-text-secondary" dir="auto">{nodeTitle(node, tr)}</span>
                {(annotations.comments[node.id] ?? []).length > 0 ? (
                  <span
                    className="ms-auto flex shrink-0 items-center gap-0.5 text-[10px] text-text-tertiary"
                    data-testid="canvas-node-comment-count"
                  >
                    <MessageSquare className="size-2.5" />
                    {(annotations.comments[node.id] ?? []).length}
                  </span>
                ) : null}
              </span>
              <span dir="auto" className="truncate text-[10px] text-text-tertiary">
                {nodeSubtitle(node, tr)}
              </span>
              <span className="mt-auto text-[10px] text-text-quaternary">
                {tr(NODE_TYPE_KEYS[node.type] ?? node.type)} · {tr(NODE_STATUS_KEYS[node.status] ?? node.status)}
              </span>
              <NodeTagPicker
                value={annotations.tags[node.id] ?? 'none'}
                tr={tr}
                onPick={(colour) => setColour(node.id, colour)}
              />
            </div>
          ))}

          {annotations.notes.map((note) => (
            <div
              key={note.id}
              data-testid="canvas-note"
              data-note-id={note.id}
              data-note-colour={note.colour}
              data-note-editing={note.id === editingNoteId ? 'true' : 'false'}
              onPointerDown={(event) => beginNoteDrag(event, note)}
              dir="auto"
              className="absolute flex flex-col gap-1 rounded-card border border-border-main bg-bg-menu p-2 shadow-sm"
              style={{
                width: NOTE_WIDTH,
                minHeight: NOTE_MIN_HEIGHT,
                borderInlineStartWidth: 3,
                borderInlineStartColor: CANVAS_TAG_COLOUR_CSS[note.colour],
                transform: `translate(${view.panX + note.x * view.scale}px, ${view.panY + note.y * view.scale}px)`,
              }}
            >
              <textarea
                value={note.text}
                onChange={(event) => {
                  const text = event.target.value;
                  setAnnotations((prev) => ({
                    ...prev,
                    notes: prev.notes.map((entry) => (entry.id === note.id ? { ...entry, text } : entry)),
                  }));
                }}
                // The note saves when the caret leaves it, so a keystroke is never
                // a network round trip and the panel never loses what was typed.
                onBlur={() => void updateNote(note.id, { text: note.text })}
                onFocus={() => setEditingNoteId(note.id)}
                rows={2}
                aria-label={tr('Note')}
                data-testid="canvas-note-text"
                className="w-full resize-none bg-transparent text-[11px] text-text-primary outline-none"
              />
              <div className="flex items-center gap-1">
                <NoteColourPicker
                  value={note.colour}
                  tr={tr}
                  onPick={(colour) => void updateNote(note.id, { colour })}
                  testId="canvas-note-colour"
                />
                <button
                  type="button"
                  onClick={() => void removeNote(note.id)}
                  title={tr('Delete note')}
                  aria-label={tr('Delete note')}
                  data-testid="canvas-note-delete"
                  className="ms-auto rounded-control p-0.5 text-text-tertiary hover:bg-fill-hover hover:text-func-error"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            </div>
          ))}

          {nodes.length === 0 && annotations.notes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <Waypoints className="size-8 text-text-quaternary" />
              <p className="text-sm text-text-tertiary" data-testid="canvas-empty">
                {tr('The canvas is empty. Nodes appear here as the task runs.')}
              </p>
            </div>
          )}

          <Minimap
            nodes={nodes}
            nodeWidth={NODE_WIDTH}
            nodeHeight={NODE_HEIGHT}
            viewWidth={viewport.width}
            viewHeight={viewport.height}
            offsetX={viewport.offsetX}
            offsetY={viewport.offsetY}
            tags={annotations.tags}
            matches={searching ? matchedIds : undefined}
            onNavigate={navigateTo}
            tr={tr}
          />
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

          {searching ? (
            <div className="shrink-0 border-b border-border-main p-2" data-testid="canvas-search-results">
              <p className="mb-1 flex items-center gap-1 text-[11px] text-text-tertiary">
                <Search className="size-3" />
                {searchHits.length} {tr('matches')}
              </p>
              {searchHits.length === 0 ? (
                <p className="text-[11px] text-text-tertiary">{tr('No matches on this canvas.')}</p>
              ) : (
                <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
                  {searchHits.map((hit) => (
                    <li key={hit.nodeId}>
                      <button
                        type="button"
                        onClick={() => setExpandedId(hit.nodeId)}
                        data-testid="canvas-search-hit"
                        data-node-id={hit.nodeId}
                        className="w-full truncate rounded-control px-1.5 py-1 text-start text-[11px] text-text-secondary hover:bg-fill-hover"
                      >
                        {hit.title || tr(NODE_TYPE_KEYS[hit.nodeType] ?? hit.nodeType)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <div className="shrink-0 border-b border-border-main p-2" data-testid="canvas-notes">
            <p className="flex items-center gap-1 text-[11px] text-text-tertiary">
              <StickyNote className="size-3" />
              {tr('Notes')}
              <span className="ms-auto tabular-nums">{annotations.notes.length}</span>
            </p>
            {annotations.notes.length === 0 ? (
              <p className="mt-1 text-[11px] text-text-quaternary">{tr('No notes yet.')}</p>
            ) : (
              <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto">
                {annotations.notes.map((note) => (
                  <li key={note.id}>
                    <button
                      type="button"
                      onClick={() => setEditingNoteId(note.id === editingNoteId ? null : note.id)}
                      data-testid="canvas-notes-item"
                      data-note-id={note.id}
                      className="w-full truncate rounded-control px-1.5 py-1 text-start text-[11px] text-text-secondary hover:bg-fill-hover"
                    >
                      {note.text.trim() || tr('Note')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {expanded ? (
            <CommentThread
              node={expanded}
              comments={annotations.comments[expanded.id] ?? []}
              onAdd={(text) => addComment(expanded.id, text)}
              onRemove={(commentId) => removeComment(expanded.id, commentId)}
              tr={tr}
            />
          ) : null}

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
      {replayNotice ? (
        <div
          className="shrink-0 border-t border-border-main bg-fill-tsp px-2 py-1 text-[11px] text-text-secondary"
          data-testid="canvas-replay-notice"
        >
          {replayNotice}
        </div>
      ) : null}

      {expanded ? (
        <NodeDetail
          node={expanded}
          events={events}
          isRtl={isRtl}
          tr={tr}
          client={apiRef.current}
          runId={taskId}
          onClose={() => setExpandedId(null)}
          onPatch={(patch) => void savePatch(expanded.id, patch)}
        />
      ) : null}

      {shortcutsOpen ? <ShortcutsDialog tr={tr} onClose={() => setShortcutsOpen(false)} /> : null}
    </div>
  );
}

/** The swatch row both the node card and the note card use to set a colour. */
function TagColourPicker({
  value,
  tr,
  onPick,
  testId,
}: {
  value: CanvasTagColour;
  tr: (key: string) => string;
  onPick: (colour: CanvasTagColour) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label={tr('Tags')}>
      {CANVAS_TAG_COLOURS.map((colour) => (
        <button
          key={colour}
          type="button"
          role="radio"
          aria-checked={value === colour}
          title={tr(TAG_COLOUR_KEYS[colour])}
          aria-label={tr(TAG_COLOUR_KEYS[colour])}
          data-testid={`${testId}-${colour}`}
          onClick={(event) => {
            // A swatch inside a node card must not start dragging the node.
            event.stopPropagation();
            onPick(colour);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="rounded-full border border-border-main p-0.5 hover:border-border-dark"
        >
          <span
            className="block size-2.5 rounded-full"
            style={{ backgroundColor: CANVAS_TAG_COLOUR_CSS[colour] }}
          />
        </button>
      ))}
    </div>
  );
}

/** The node card's tag row: the same swatches as the note, without the note's toolbar. */
function NodeTagPicker({
  value,
  tr,
  onPick,
}: {
  value: CanvasTagColour;
  tr: (key: string) => string;
  onPick: (colour: CanvasTagColour) => void;
}) {
  return <TagColourPicker value={value} tr={tr} onPick={onPick} testId="canvas-node-tag" />;
}

/** The note card's tag row. */
function NoteColourPicker({
  value,
  tr,
  onPick,
  testId,
}: {
  value: CanvasTagColour;
  tr: (key: string) => string;
  onPick: (colour: CanvasTagColour) => void;
  testId: string;
}) {
  return <TagColourPicker value={value} tr={tr} onPick={onPick} testId={testId} />;
}

/** One node's comment thread, in the side rail next to the recipe. */
function CommentThread({
  node,
  comments,
  onAdd,
  onRemove,
  tr,
}: {
  node: CanvasLayoutNode;
  comments: CanvasComment[];
  onAdd: (text: string) => void;
  onRemove: (commentId: string) => void;
  tr: (key: string) => string;
}) {
  const [draft, setDraft] = useState('');
  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    onAdd(text);
    setDraft('');
  };

  return (
    <section className="shrink-0 border-b border-border-main p-2" data-testid="canvas-comments">
      <p className="flex items-center gap-1 text-[11px] text-text-tertiary">
        <MessageSquare className="size-3" />
        {tr('Comments')}
      </p>
      <p className="mt-1 truncate text-[11px] text-text-quaternary" dir="auto">
        {nodeTitle(node, tr)}
      </p>
      {comments.length === 0 ? (
        <p className="mt-1 text-[11px] text-text-quaternary">{tr('No comments yet.')}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {comments.map((comment) => (
            <li key={comment.id} className="group rounded-control bg-bg-main px-1.5 py-1">
              <div className="flex items-center gap-1 text-[10px] text-text-tertiary">
                <span className="truncate" dir="auto">
                  {comment.author}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(comment.id)}
                  title={tr('Delete')}
                  aria-label={tr('Delete')}
                  data-testid="canvas-comment-delete"
                  className="ms-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-func-error focus-visible:opacity-100"
                >
                  <X className="size-2.5" />
                </button>
              </div>
              <p className="whitespace-pre-wrap text-[11px] text-text-secondary" dir="auto">
                {comment.text}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex items-center gap-1">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={tr('Add a comment')}
          aria-label={tr('Add a comment')}
          data-testid="canvas-comment-input"
          dir="auto"
          className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-1.5 py-1 text-[11px] text-text-primary outline-none focus:border-icon-blue"
        />
        <button
          type="button"
          onClick={submit}
          disabled={draft.trim().length === 0}
          title={tr('Add comment')}
          aria-label={tr('Add comment')}
          data-testid="canvas-comment-submit"
          className="shrink-0 rounded-control p-1 text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:opacity-40"
        >
          <MessageSquare className="size-3" />
        </button>
      </div>
    </section>
  );
}

/** The keyboard shortcut sheet, opened by the ? shortcut or the toolbar button. */
function ShortcutsDialog({ tr, onClose }: { tr: (key: string) => string; onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['E', tr('Open the newest node')],
    ['S', tr('Search the canvas')],
    ['N', tr('Add a note')],
    ['?', tr('Keyboard shortcuts')],
    ['+ / -', tr('Zoom in or out')],
    ['Esc', tr('Close')],
  ];
  return (
    <div
      className="absolute end-2 top-10 z-20 w-64 rounded-card border border-border-main bg-bg-menu p-2 shadow-md"
      role="dialog"
      aria-label={tr('Keyboard shortcuts')}
      data-testid="canvas-shortcuts"
    >
      <div className="flex items-center gap-1 text-xs text-text-secondary">
        <Keyboard className="size-3.5" />
        <span>{tr('Keyboard shortcuts')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('Close')}
          className="ms-auto rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <dl className="mt-1 flex flex-col gap-1">
        {rows.map(([keys, description]) => (
          <div key={keys} className="flex items-center gap-2 text-[11px]">
            <kbd className="shrink-0 rounded-control border border-border-main bg-bg-main px-1.5 py-0.5 text-[10px] text-text-secondary">
              {keys}
            </kbd>
            <span className="text-text-tertiary">{description}</span>
          </div>
        ))}
      </dl>
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
  onPatch,
  client,
  runId,
}: {
  node: CanvasLayoutNode;
  events: ChatEvent[];
  isRtl: boolean;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
  onPatch: (patch: CanvasNodePatch) => void;
  /** Absent when the panel has no client yet (first render); panels wait for it. */
  client?: CanvasClient | null;
  /** The run this node belongs to, needed for every node action. */
  runId?: string;
}) {
  const [draft, setDraft] = useState<string>(() => readString(node.data, TITLE_KEYS));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const related = useMemo(
    () => events.filter((event) => event.type === 'toolUsed').slice(-5),
    [events],
  );

  /**
   * The node-action panels (N13: versions, knowledge, webpage) each decide for
   * themselves whether a node kind supports them, so the sheet only has to hand
   * them the client and the run. Without a client there is nothing to render:
   * the panel's own guard skips it rather than making the sheet special-case a
   * moment that only exists on the first render.
   */
  const canAct = Boolean(client && runId);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const data = typeof node.data === 'object' && node.data !== null ? (node.data as Record<string, unknown>) : {};
      const key = typeof data.title === 'string' ? 'title' : typeof data.query === 'string' ? 'query' : 'title';
      onPatch({ data: { ...data, [key]: draft } });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside
      className="flex max-h-[45%] w-full shrink-0 flex-col gap-2 border-t border-border-main bg-bg-menu p-3"
      data-testid="canvas-node-detail"
      data-node-id={node.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary" dir="auto">
            {nodeTitle(node, tr)}
          </p>
          <p className="text-[11px] text-text-tertiary">
            {tr(NODE_TYPE_KEYS[node.type] ?? node.type)} · {tr(NODE_STATUS_KEYS[node.status] ?? node.status)}
          </p>
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

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        dir="auto"
        className="w-full resize-y rounded-control border border-border-main bg-bg-main p-2 text-xs text-text-primary outline-none focus:border-icon-blue"
        aria-label={tr('Edit this node')}
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-control bg-fill-tsp px-2 py-1 text-xs font-medium text-text-primary hover:bg-fill-hover disabled:opacity-50"
        >
          {saving ? tr('Saving') : tr('Save')}
        </button>
        {isRtl ? <span className="text-[11px] text-text-tertiary">{tr('RTL')}</span> : null}
        {saveError ? <span className="text-[11px] text-func-error">{saveError}</span> : null}
      </div>

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

      {canAct && client && runId ? (
        <div
          className="flex shrink-0 flex-col gap-3 border-t border-border-main pt-2"
          data-testid="canvas-node-actions"
        >
          <VersionPanel client={client} runId={runId} nodeId={node.id} nodeType={node.type} tr={tr} />
          <KnowledgePanel client={client} runId={runId} nodeId={node.id} nodeType={node.type} tr={tr} />
          <WebpageActions
            client={client}
            runId={runId}
            nodeId={node.id}
            nodeType={node.type}
            tr={tr}
            apiBase={getLoamBase()}
          />
        </div>
      ) : null}
    </aside>
  );
}

export default CanvasPanel;
