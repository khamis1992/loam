'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Link2, XCircle } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { t, PRODUCT } from '@/i18n/t';
import { EventList } from '@/components/chat/EventList';
import { getApiBase, getLoamBase } from '@/services/rpc';
import { visibleMessages } from '@/lib/reminders';
import type { ChatEvent, ChatMessageEvent } from '@shared/socket';

interface SharedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
}

export interface SharedTranscript {
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages: SharedMessage[];
  artifacts: string[];
  /** Neo N14: the sanitized run graph, so a shared task can be replayed as a
   *  read-only timeline. Built and scrubbed by the server, which is also where
   *  credentials are stripped; a share with no graph nodes carries no replay. */
  replay?: SharedReplay;
}

/** Mirrors `RunReplay` in `src/graph/export.ts`; only the fields the share page
 *  renders are repeated, because the web package cannot import the server module. */
export interface SharedReplay {
  runId: string;
  title: string;
  nodes: Array<{ id: string; parent_ids: string[]; type: string; status: string; data?: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string }>;
  frames: Array<{ index: number; nodeId: string; type: string; status: string; label: string }>;
  outputs: Array<{ path: string; kind: string; mime: string; sizeBytes: number }>;
  stats: { totalNodes: number; nodesByType: Record<string, number>; nodesByStatus: Record<string, number>; edges: number; depth: number; durationMs: number };
  redactions: number;
  partial: boolean;
}

/** The fields a frame label may be read from, in order of specificity. */
const LABEL_KEYS = ['title', 'query', 'url', 'path', 'summary', 'reason', 'message', 'verdict', 'tool', 'stepId'] as const;

function labelFor(data: Record<string, unknown> | undefined): string {
  if (data) {
    for (const key of LABEL_KEYS) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

/**
 * Resolve the share token from the URL: `/share/<token>` (path form) or
 * `/share?t=<token>` (query form). The path form is what the server returns;
 * the query form keeps older links working.
 */
function resolveToken(searchParams: URLSearchParams, pathname: string): string {
  const fromQuery = searchParams.get('t');
  if (fromQuery) return fromQuery;
  if (pathname.startsWith('/share/')) {
    const tail = pathname.slice('/share/'.length).replace(/\/+$/, '');
    if (tail) return decodeURIComponent(tail);
  }
  return '';
}

/**
 * Public read-only share replay (option #11): renders the shared transcript with
 * the same chat components as the live task view — no composer, no actions.
 * Data comes from GET /api/share/:token. Shared by both `/share` and
 * `/share/[token]` so a copied link works however it was opened.
 */
/**
 * Neo N14: the shared run graph.
 *
 * Read-only by construction: no inputs that change anything, no composer, no
 * actions. The scrubber only reveals nodes the agent had already produced, and
 * the bundle it reveals was sanitized by the server before it was published.
 */
export function ReplaySection({ replay }: { replay: SharedReplay }) {
  const [upTo, setUpTo] = useState(replay.frames.length - 1);
  const revealed = new Set(replay.frames.slice(0, upTo + 1).map((frame) => frame.nodeId));
  const shownEdges = replay.edges.filter((edge) => revealed.has(edge.from) && revealed.has(edge.to)).length;

  return (
    <section className="mb-6 rounded-card border border-border-main bg-bg-menu p-3" data-testid="share-replay">
      <h2 className="mb-2 text-sm font-semibold text-text-primary">{t('Replay viewer')}</h2>
      {replay.partial && (
        <p className="mb-2 text-xs text-text-secondary">
          {t('This run was still in progress when it was exported.')}
        </p>
      )}
      <ol className="mb-3 flex flex-col gap-1" data-testid="share-replay-timeline">
        {replay.frames.map((frame) => (
          <li
            key={frame.nodeId}
            className={`flex items-baseline gap-2 rounded-control border px-2 py-1.5 text-xs ${
              revealed.has(frame.nodeId)
                ? 'border-border-main bg-bg-menu'
                : 'border-border-main bg-fill-tsp opacity-40'
            }`}
          >
            <span className="shrink-0 text-text-tertiary">{frame.type}</span>
            <span className="min-w-0 break-words" dir="auto">
              {frame.label || labelFor(replay.nodes.find((node) => node.id === frame.nodeId)?.data)}
            </span>
          </li>
        ))}
      </ol>
      {replay.outputs.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {replay.outputs.map((output) => (
            <li key={output.path} className="flex items-baseline gap-2 text-xs text-text-tertiary">
              <span className="shrink-0">{output.kind}</span>
              <span className="min-w-0 break-words font-mono" dir="auto">{output.path}</span>
            </li>
          ))}
        </ul>
      )}
      <input
        type="range"
        min={0}
        max={Math.max(0, replay.frames.length - 1)}
        step={1}
        value={Math.max(0, Math.min(upTo, replay.frames.length - 1))}
        onChange={(event) => setUpTo(Number(event.target.value))}
        className="w-full accent-function-primary"
        aria-label={t('Timeline')}
        data-testid="share-replay-scrubber"
      />
      <p className="mt-1 text-[11px] text-text-quaternary">
        {revealed.size} / {replay.stats.totalNodes} · {shownEdges} / {replay.stats.edges}
        {replay.redactions > 0 ? ` · ${replay.redactions} ${t('credentials removed')}` : ''}
      </p>
    </section>
  );
}

export function ShareReplay() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const token = resolveToken(searchParams, pathname);
  const [state, setState] = useState<'loading' | 'ready' | 'not-found' | 'invalid'>('loading');
  const [transcript, setTranscript] = useState<SharedTranscript | null>(null);

  useEffect(() => {
    if (!token.trim()) { setState('invalid'); return; }
    let cancelled = false;
    (async () => {
      // Desktop renders behind the protocol adapter; a hosted web deployment
      // uses the same-origin /api; a direct Loam server is the last resort.
      const bases = [...new Set([getApiBase(), getLoamBase()])];
      for (const base of bases) {
        try {
          const res = await fetch(`${base}/api/share/${encodeURIComponent(token)}`);
          if (res.status === 404) { if (!cancelled) setState('not-found'); continue; }
          if (!res.ok) continue;
          const data = (await res.json()) as { transcript?: SharedTranscript };
          if (!data.transcript) continue;
          if (!cancelled) { setTranscript(data.transcript); setState('ready'); }
          return;
        } catch {
          // try the next base
        }
      }
      if (!cancelled) setState('not-found');
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const events: ChatEvent[] = useMemo(() => visibleMessages(transcript?.messages ?? [])
    .filter((m) => m.role !== 'system')
    .map((m, i): ChatMessageEvent => ({
      id: `share-${i}`,
      type: 'chat',
      timestamp: Date.parse(m.at) || 0,
      sender: m.role === 'user' ? 'user' : 'assistant',
      messageType: 'text',
      content: m.content,
      attachments: [],
      deliveryKind: 'result',
    })), [transcript]);

  return (
    <main className="mx-auto w-full max-w-[768px] px-6 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span className="text-lg">◉</span>
        <span className="text-base font-semibold text-text-primary">{PRODUCT}</span>
        <span className="ms-auto inline-flex items-center gap-1 rounded-full bg-fill-tsp px-2.5 py-1 text-xs text-text-secondary">
          <Link2 className="size-3" aria-hidden /> {t('Read-only shared task')}
        </span>
      </div>
      {state === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-secondary">
          <Loader2 className="size-5 animate-spin" /> {t('Loading')}
        </div>
      )}
      {(state === 'not-found' || state === 'invalid') && (
        <div className="flex flex-col items-center gap-2 py-16 text-sm text-text-secondary">
          <XCircle className="size-6 text-function-error" aria-hidden />
          {t('This share link is invalid or has been revoked.')}
        </div>
      )}
      {state === 'ready' && transcript && (
        <>
          <h1 className="mb-2 text-xl font-semibold text-text-primary">{transcript.title}</h1>
          {transcript.artifacts.length > 0 && (
            <p className="mb-4 text-sm text-text-tertiary">
              {t('Files produced: {names}', { names: transcript.artifacts.join(', ') })}
            </p>
          )}
          {transcript.replay && (
            <ReplaySection replay={transcript.replay} />
          )}
          <EventList events={events} sessionId="share" />
        </>
      )}
    </main>
  );
}
