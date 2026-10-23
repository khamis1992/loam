'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { FilmcraftBridge, FILMCRAFT_FRAME_URL } from '@/lib/filmcraft';
import { setLoamVideoTarget } from '@/lib/filmcraftClient';
import { exportLoamVideo, type LoamVideoExportProgress } from '@/lib/videoStudioExport';

export type LoamVideoBridgeStatus = 'loading' | 'ready' | 'unavailable';

export interface LoamVideoPanelProps {
  /** Task that owns the studio; reported to the fc-02 client hook. */
  taskId?: string;
  /** Task-workspace video path imported automatically once the studio is ready. */
  sourcePath?: string | null;
  /** Notified whenever the editor API availability changes. */
  onStatusChange?: (status: LoamVideoBridgeStatus) => void;
  /** Notified with the bridge once the editor API is ready. */
  onBridgeReady?: (bridge: FilmcraftBridge) => void;
}

/** One-shot export state for the panel's header button. */
type ExportState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: number | null }
  | { phase: 'done'; name: string; path: string; bytes: number }
  | { phase: 'error'; message: string };

/**
 * Shared "Loam Video" studio surface: mounts the FilmCraft iframe, owns its
 * bridge, imports an optional source clip and reports availability.
 *
 * Used by the `/app/video` page and the `loam-video` Workspace panel editor.
 * Rendering the iframe is safe even when the vendored dist is missing — the
 * host decides what to show for the `unavailable` status.
 *
 * The Export button renders the timeline through the server (fc-06) and saves
 * the file into the task's files; it needs a taskId, so it stays hidden on the
 * standalone `/app/video` page.
 */
export function LoamVideoPanel({ taskId, sourcePath, onStatusChange, onBridgeReady }: LoamVideoPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FilmcraftBridge | null>(null);
  const importedRef = useRef<string | null>(null);
  const [status, setStatus] = useState<LoamVideoBridgeStatus>('loading');
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });

  // Keep latest callbacks in refs so a parent re-render never remounts the bridge.
  const statusCb = useRef(onStatusChange);
  statusCb.current = onStatusChange;
  const readyCb = useRef(onBridgeReady);
  readyCb.current = onBridgeReady;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const bridge = new FilmcraftBridge(iframe);
    bridgeRef.current = bridge;
    let disposed = false;
    setStatus('loading');
    statusCb.current?.('loading');

    bridge
      .waitForApi()
      .then(({ hasApi }) => {
        if (disposed) return;
        const next: LoamVideoBridgeStatus = hasApi ? 'ready' : 'unavailable';
        setStatus(next);
        statusCb.current?.(next);
        if (!hasApi) return;
        readyCb.current?.(bridge);
        if (sourcePath && importedRef.current !== sourcePath) {
          importedRef.current = sourcePath;
          void bridge.importFiles(sourcePath).catch(() => {
            /* the editor may not expose importFiles yet; fc-02 wires the real path */
          });
        }
      })
      .catch(() => {
        if (disposed) return;
        setStatus('unavailable');
        statusCb.current?.('unavailable');
      });

    return () => {
      disposed = true;
      bridgeRef.current = null;
      bridge.dispose();
    };
    // Remount only when the source clip changes; callbacks are read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath]);

  // Register with the fc-02 client hook so agent commands reach this studio.
  // The standalone /app/video page has no task, so it does not register.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!taskId || status !== 'ready' || !bridge) return;
    setLoamVideoTarget({
      taskId,
      bridge,
      hasApi: true,
      importSource: (path: string) => bridge.importFiles(path),
    });
    return () => setLoamVideoTarget(null);
  }, [status, taskId]);

  const runExport = async () => {
    if (!taskId || status !== 'ready') return;
    setExportState({ phase: 'running', progress: null });
    try {
      const result = await exportLoamVideo({
        taskId,
        options: { format: 'mp4' },
        onProgress: (progress: LoamVideoExportProgress) => {
          setExportState({
            phase: 'running',
            progress: progress.progress ?? null,
          });
        },
      });
      setExportState({ phase: 'done', name: result.name, path: result.path, bytes: result.bytes });
    } catch (error) {
      setExportState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const exporting = exportState.phase === 'running';

  return (
    <div className="relative flex h-full w-full flex-col bg-black">
      <div className="flex h-row shrink-0 items-center gap-2 border-b border-border-main bg-bg-menu px-3">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            status === 'ready'
              ? 'bg-fill-tsp text-text-secondary'
              : status === 'unavailable'
                ? 'bg-function-error-tsp text-function-error'
                : 'bg-fill-tsp text-text-tertiary'
          }`}
        >
          {status === 'ready' ? t('Ready') : status === 'unavailable' ? t('Unavailable') : t('Loading')}
        </span>
        {exportState.phase === 'done' && (
          <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-text-tertiary" title={exportState.path}>
            <Check className="size-3.5 shrink-0 text-function-success" />
            {exportState.name} ({formatBytes(exportState.bytes)})
          </span>
        )}
        {exportState.phase === 'error' && (
          <span className="min-w-0 flex-1 truncate text-xs text-function-error" title={exportState.message}>
            {exportState.message}
          </span>
        )}
        {taskId && (
          <button
            type="button"
            data-testid="loam-video-export"
            disabled={status !== 'ready' || exporting}
            onClick={() => void runExport()}
            className="flex h-row-sm shrink-0 items-center gap-1.5 rounded-control bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover disabled:opacity-50"
          >
            {exporting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {exportState.progress !== null ? `${Math.round(exportState.progress * 100)}%` : t('Exporting')}
              </>
            ) : (
              <>
                <Download className="size-4" /> {t('Export')}
              </>
            )}
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={iframeRef}
          src={FILMCRAFT_FRAME_URL}
          title={t('Loam Video')}
          className="h-full w-full border-0"
          allow="autoplay; fullscreen"
        />
        {status === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-menu">
            <div className="flex items-center gap-2 text-sm text-text-tertiary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

export default LoamVideoPanel;
