'use client';

/**
 * Neo N14: the replay viewer.
 *
 * The server (N14) can export a run as a *self-contained* static page: the bundle
 * is inlined, so that file opens offline from a `file://` URL or an email
 * attachment and makes no network request at all. This component is the in-app
 * twin of that page: it fetches the same bundle (GET /api/graph/:runId/replay),
 * renders the run graph, and drives the timeline scrubber over it.
 *
 * It is deliberately view-only: there is no composer, no PATCH, no edit control.
 * The only action is exporting, which produces a new read-only artifact.
 *
 * Everything user-visible goes through `t()`, and the layout uses logical CSS
 * (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`) so it reads correctly under
 * `dir="rtl"`. The graph surface itself is `dir="ltr"` because its geometry is
 * graph space, not text flow — the same rule the N2 canvas follows.
 */
import { Loader2, Pause, Play, RotateCcw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/i18n/t';
import { getApiBase } from '@/services/rpc';

/** Mirrors `src/graph/export.ts`. Kept local: the web package must not import the
 *  server's Node modules (they pull in SQLite). */
export interface ReplayNode {
  id: string;
  parent_ids: string[];
  type: string;
  status: string;
  data?: Record<string, unknown>;
  position: number;
  created: number;
  updated: number;
}

export interface ReplayFrame {
  index: number;
  nodeId: string;
  at: number;
  type: string;
  status: string;
  label: string;
}

export interface ReplayOutput {
  path: string;
  title: string;
  kind: string;
  mime: string;
  sizeBytes: number;
}

export interface RunReplay {
  format: number;
  runId: string;
  title: string;
  createdAt: string;
  generatedAt: string;
  nodes: ReplayNode[];
  edges: Array<{ from: string; to: string }>;
  frames: ReplayFrame[];
  outputs: ReplayOutput[];
  stats: {
    totalNodes: number;
    nodesByType: Record<string, number>;
    nodesByStatus: Record<string, number>;
    edges: number;
    depth: number;
    durationMs: number;
  };
  redactions: number;
  partial: boolean;
}

export interface ReplayViewerProps {
  runId: string;
  /** Injectable fetch (tests). */
  fetcher?: typeof fetch;
}

const STATUS_CLASS: Record<string, string> = {
  init: 'bg-text-quaternary',
  running: 'bg-icon-blue',
  finished: 'bg-icon-green',
  failed: 'bg-function-error',
  skipped: 'bg-text-quaternary',
};

/** Status colours live on the design tokens, so the replay matches the canvas. */
const NODE_TONE: Record<string, string> = {
  init: 'border-border-main bg-fill-tsp',
  running: 'border-icon-blue bg-fill-tsp',
  finished: 'border-icon-green bg-bg-menu',
  failed: 'border-function-error bg-fill-tsp',
  skipped: 'border-border-main bg-fill-tsp',
};

/** Fetch the sanitized bundle for one run. */
async function loadReplay(runId: string, fetcher: typeof fetch): Promise<RunReplay> {
  const res = await fetcher(`${getApiBase()}/api/graph/${encodeURIComponent(runId)}/replay`);
  if (!res.ok) throw new Error(`replay ${res.status}`);
  return (await res.json()) as RunReplay;
}

export function ReplayViewer({ runId, fetcher = fetch }: ReplayViewerProps) {
  const [replay, setReplay] = useState<RunReplay | null>(null);
  const [error, setError] = useState(false);
  const [upTo, setUpTo] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadReplay(runId, fetcher)
      .then((data) => {
        if (cancelled) return;
        setReplay(data);
        // The scrubber opens on the last frame, so the whole run is visible.
        setUpTo(Math.max(0, data.frames.length - 1));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, fetcher]);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

  const nodesById = useMemo(
    () => new Map((replay?.nodes ?? []).map((node) => [node.id, node])),
    [replay],
  );

  const lanes = useMemo(() => {
    if (!replay) return [] as number[];
    const cache = new Array<number>(replay.frames.length).fill(0);
    const order = replay.frames.map((f) => f.nodeId);
    return replay.frames.map((frame, i) => {
      const parents = (nodesById.get(frame.nodeId)?.parent_ids ?? []).filter((p) => nodesById.has(p));
      let depth = 0;
      for (const parent of parents) {
        const index = order.indexOf(parent);
        if (index >= 0 && index < i) depth = Math.max(depth, cache[index]! + 1);
      }
      cache[i] = depth;
      return depth;
    });
  }, [replay, nodesById]);

  const revealed = useMemo(() => {
    if (!replay) return new Set<string>();
    return new Set(replay.frames.slice(0, upTo + 1).map((f) => f.nodeId));
  }, [replay, upTo]);

  const shownEdges = useMemo(() => {
    if (!replay) return 0;
    return replay.edges.filter((edge) => revealed.has(edge.from) && revealed.has(edge.to)).length;
  }, [replay, revealed]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-text-secondary" data-testid="replay-error">
        <XCircle className="size-6 text-function-error" aria-hidden />
        {t('Replay export failed')}
      </div>
    );
  }

  if (!replay) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary" data-testid="replay-loading">
        <Loader2 className="size-4 animate-spin" />
        {t('Loading')}
      </div>
    );
  }

  const total = replay.frames.length;
  const laneCount = lanes.length ? Math.max(...lanes) + 1 : 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-menu" data-testid="replay-viewer">
      <div className="flex h-row-sm shrink-0 items-center gap-1 border-b border-border-main px-2">
        <button
          type="button"
          onClick={() => {
            if (playing) {
              stop();
              return;
            }
            setUpTo(0);
            setPlaying(true);
            timer.current = setInterval(() => {
              setUpTo((current) => {
                if (current >= total - 1) {
                  stop();
                  return current;
                }
                return current + 1;
              });
            }, 700);
          }}
          className="flex items-center gap-1 rounded-control px-2 py-1 text-xs text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? t('Pause') : t('Play')}
        </button>
        <button
          type="button"
          onClick={() => {
            stop();
            setUpTo(0);
          }}
          className="flex items-center gap-1 rounded-control px-2 py-1 text-xs text-text-secondary hover:bg-fill-hover hover:text-text-primary"
        >
          <RotateCcw className="size-3.5" />
          {t('Reset')}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          step={1}
          value={upTo}
          onChange={(event) => {
            stop();
            setUpTo(Number(event.target.value));
          }}
          className="min-w-0 flex-1 accent-function-primary"
          aria-label={t('Timeline')}
          data-testid="replay-scrubber"
        />
        <span className="min-w-20 text-end text-[11px] tabular-nums text-text-tertiary" data-testid="replay-counter">
          {t('Step')} {total === 0 ? 0 : upTo + 1} {t('of')} {total}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {replay.partial && (
          <p className="mb-3 rounded-control border border-border-main bg-fill-tsp px-2 py-1.5 text-xs text-text-secondary">
            {t('This run was still in progress when it was exported.')}
          </p>
        )}

        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">{t('Run graph')}</h3>
        <div
          className="relative mb-4 rounded-card border border-border-main bg-bg-menu"
          style={{ height: laneCount * 56 + 24, minWidth: 260 }}
          dir="ltr"
          data-testid="replay-graph"
        >
          {replay.frames.map((frame, i) => (
            <div
              key={frame.nodeId}
              className={`absolute transition-opacity ${revealed.has(frame.nodeId) ? 'opacity-100' : 'opacity-20'}`}
              style={{ left: 24, top: lanes[i]! * 56 + 12 }}
            >
              <span
                className={`inline-block max-w-44 truncate rounded-control border px-2 py-1 text-[11px] ${NODE_TONE[frame.status] ?? NODE_TONE.init}`}
                title={frame.label}
              >
                {frame.label}
              </span>
            </div>
          ))}
        </div>

        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">{t('Timeline')}</h3>
        <ol className="mb-4 flex flex-col gap-1" data-testid="replay-timeline">
          {replay.frames.map((frame) => (
            <li
              key={frame.nodeId}
              data-testid="replay-frame"
              data-node={frame.nodeId}
              data-revealed={revealed.has(frame.nodeId) ? 'true' : 'false'}
              className={`flex items-baseline gap-2 rounded-control border px-2 py-1.5 text-xs transition-opacity ${
                revealed.has(frame.nodeId)
                  ? 'border-border-main bg-bg-menu'
                  : 'border-border-main bg-fill-tsp opacity-35'
              } ${upTo === frame.index ? 'ring-2 ring-function-primary/30' : ''}`}
            >
              <span className={`size-2 shrink-0 rounded-full ${STATUS_CLASS[frame.status] ?? STATUS_CLASS.init}`} aria-hidden />
              <span className="shrink-0 text-text-tertiary">{frame.type}</span>
              <span className="min-w-0 break-words" dir="auto">{frame.label}</span>
            </li>
          ))}
        </ol>

        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">{t('Produced files')}</h3>
        {replay.outputs.length === 0 ? (
          <p className="text-xs text-text-tertiary">{t('No produced files')}</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="replay-outputs">
            {replay.outputs.map((output) => (
              <li key={output.path} className="break-words rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-xs">
                <span className="me-2 text-text-tertiary">{output.kind}</span>
                <span className="font-mono text-[11px]" dir="auto">{output.path}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-[11px] text-text-quaternary">
          {revealed.size} / {replay.stats.totalNodes} · {shownEdges} / {replay.stats.edges}
          {replay.redactions > 0 ? ` · ${replay.redactions} ${t('credentials removed')}` : ''}
        </p>
      </div>
    </div>
  );
}
