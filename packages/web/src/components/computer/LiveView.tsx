'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Globe, Loader2, Monitor, MonitorOff, Radio } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

export type LiveSource = 'screen' | 'browser';

export interface LiveFramePayload {
  source: LiveSource;
  data: string | null;
  mediaType: string;
  at: number;
  width: number | null;
  height: number | null;
  url: string | null;
  title: string | null;
}

export interface LiveStatus {
  screen?: { available: boolean; running: boolean };
  browser?: { available: boolean; url: string | null };
  available?: boolean;
}

type FrameMap = Partial<Record<LiveSource, LiveFramePayload>>;

interface LiveViewProps {
  /** Web session uid; also used as a fallback key for frame lookups. */
  sessionId: string;
  /** Real Loam task id when known (frames are keyed by task id server-side). */
  taskId?: string;
}

/** Live computer screen + browser stream view for the task right panel.
 *  Consumes the backend SSE endpoint /api/live-view/stream and falls back to
 *  polling /api/live-view/frame when streaming is unavailable. Renders a
 *  graceful placeholder when the streaming infra is disabled (feature flag). */
export function LiveView({ sessionId, taskId }: LiveViewProps) {
  const apiBase = useMemo(() => getApiBase(), []);
  const keyFor = taskId || sessionId;
  const [source, setSource] = useState<LiveSource>('screen');
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [frames, setFrames] = useState<FrameMap>({});
  const [connected, setConnected] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);

  // Feature-flag probe: decides live stream vs. graceful placeholder.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ taskId: keyFor });
        const res = await fetch(`${apiBase}/api/live-view/status?${params}`, { headers: await getApiHeaders() });
        if (res.ok && !cancelled) setStatus((await res.json()) as LiveStatus);
      } catch {
        /* stays null; placeholder logic still applies */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, keyFor]);

  // SSE stream (fetch-based so we can send the local auth header).
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const run = async () => {
      try {
        const params = new URLSearchParams({ taskId: keyFor, source: 'both' });
        const res = await fetch(`${apiBase}/api/live-view/stream?${params}`, {
          headers: await getApiHeaders(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`live stream status ${res.status}`);
        if (!cancelled) {
          setConnected(true);
          setStreamFailed(false);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const sep = buffer.indexOf('\n\n');
            if (sep < 0) break;
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            handleSseChunk(chunk);
          }
        }
      } catch {
        if (!cancelled) {
          setConnected(false);
          setStreamFailed(true);
        }
      }
    };
    const handleSseChunk = (chunk: string) => {
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) return;
      let ev: (LiveFramePayload & { type?: string }) | { type: 'status'; screen?: LiveStatus['screen']; browser?: LiveStatus['browser'] };
      try {
        ev = JSON.parse(dataLine.slice(6));
      } catch {
        return;
      }
      if (!ev || cancelled) return;
      if (ev.type === 'status') {
        const st = ev as { screen?: LiveStatus['screen']; browser?: LiveStatus['browser'] };
        setStatus((prev) => ({ screen: st.screen ?? prev?.screen, browser: st.browser ?? prev?.browser, available: true }));
      } else if (ev.type === 'frame' && 'source' in ev) {
        const frame = ev as LiveFramePayload;
        setFrames((prev) => ({ ...prev, [frame.source]: frame }));
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
      setConnected(false);
    };
  }, [apiBase, keyFor]);

  // Polling fallback when SSE is unavailable (e.g. proxies buffering streams).
  useEffect(() => {
    if (!streamFailed) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const params = new URLSearchParams({ taskId: keyFor, source });
        const res = await fetch(`${apiBase}/api/live-view/frame?${params}`, { headers: await getApiHeaders() });
        if (!res.ok) return;
        const data = (await res.json()) as { frame?: LiveFramePayload | null; available?: boolean };
        if (cancelled) return;
        if (typeof data.available === 'boolean' && source === 'screen') {
          setStatus((prev) => ({ ...prev, screen: { available: data.available!, running: prev?.screen?.running ?? false } }));
        }
        if (data.frame) setFrames((prev) => ({ ...prev, [source]: data.frame as LiveFramePayload }));
      } catch {
        /* keep polling */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [apiBase, keyFor, source, streamFailed]);

  const screenAvailable = status?.screen?.available ?? false;
  const overallAvailable = status?.available ?? true;
  const frame = frames[source];
  const lastAt = frame?.at ? new Date(frame.at).toLocaleTimeString() : null;

  if (!overallAvailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
        <MonitorOff className="size-6 text-text-tertiary" />
        <p className="text-sm text-text-tertiary">{t('Live view unavailable')}</p>
        <p className="text-xs text-text-quaternary">{t('Live streaming is not enabled in this build.')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-row-sm shrink-0 items-center gap-2 border-b border-border-main px-2">
        <SourceChip active={source === 'screen'} disabled={false} onClick={() => setSource('screen')} icon={<Monitor className="size-3.5" />} label={t('Live screen')} />
        <SourceChip active={source === 'browser'} disabled={false} onClick={() => setSource('browser')} icon={<Globe className="size-3.5" />} label={t('Live browser')} />
        <span className="ms-auto flex items-center gap-1.5 text-[10px] text-text-tertiary" title={connected ? t('Live stream connected') : t('Live stream connecting…')}>
          <Radio
            className={`size-3.5 ${connected ? 'animate-pulse text-func-success' : 'text-text-quaternary'}`}
            aria-hidden="true"
          />
          {lastAt ? <span className="font-mono">{lastAt}</span> : null}
        </span>
      </div>

      <div className="flex-1 overflow-auto bg-[#111114] p-2">
        {frame?.data ? (
          <img
            src={`data:${frame.mediaType};base64,${frame.data}`}
            alt={frame.title || t('Live screen')}
            className="mx-auto max-h-full w-auto max-w-full rounded-card border border-border-main"
          />
        ) : (
          <Placeholder source={source} screenAvailable={screenAvailable} connected={connected} />
        )}
      </div>

      {source === 'browser' && frame?.url ? (
        <div className="flex h-row-sm shrink-0 items-center gap-1.5 border-t border-border-main px-2 text-xs text-text-tertiary">
          <Globe className="size-3 shrink-0" />
          <span className="truncate font-mono">{frame.title ? `${frame.title} — ${frame.url}` : frame.url}</span>
          <a href={frame.url} target="_blank" rel="noreferrer" className="ms-auto shrink-0 text-[var(--text-blue)] hover:underline">
            {t('Open')}
          </a>
        </div>
      ) : null}
    </div>
  );
}

function SourceChip({
  active,
  disabled,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex items-center gap-1.5 rounded-control border px-2 py-1 text-xs font-medium',
        active
          ? 'border-[var(--icon-blue)] bg-fill-tsp text-text-primary'
          : 'border-border-main text-text-tertiary hover:bg-fill-hover hover:text-text-secondary',
        disabled ? 'cursor-not-allowed opacity-40' : '',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}

function Placeholder({
  source,
  screenAvailable,
  connected,
}: {
  source: LiveSource;
  screenAvailable: boolean;
  connected: boolean;
}) {
  if (source === 'screen' && !screenAvailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
        <MonitorOff className="size-6 text-text-tertiary" />
        <p className="text-sm text-text-tertiary">{t('Live screen view unavailable')}</p>
        <p className="text-xs text-text-quaternary">{t('Screen streaming is disabled in this build.')}</p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
      {connected ? (
        <>
          <Loader2 className="size-5 animate-spin text-text-tertiary" />
          <p className="text-sm text-text-tertiary">{t('Waiting for live frames…')}</p>
          {source === 'browser' && (
            <p className="text-xs text-text-quaternary">{t('No live browser activity yet. Frames appear when the agent uses the browser.')}</p>
          )}
        </>
      ) : (
        <>
          <Loader2 className="size-5 animate-spin text-text-tertiary" />
          <p className="text-sm text-text-tertiary">{t('Connecting to live view…')}</p>
        </>
      )}
    </div>
  );
}
