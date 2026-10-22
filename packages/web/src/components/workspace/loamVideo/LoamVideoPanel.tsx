'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { FilmcraftBridge, FILMCRAFT_FRAME_URL } from '@/lib/filmcraft';
import { setLoamVideoTarget } from '@/lib/filmcraftClient';

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

/**
 * Shared "Loam Video" studio surface: mounts the FilmCraft iframe, owns its
 * bridge, imports an optional source clip and reports availability.
 *
 * Used by the `/app/video` page and the `loam-video` Workspace panel editor.
 * Rendering the iframe is safe even when the vendored dist is missing — the
 * host decides what to show for the `unavailable` status.
 */
export function LoamVideoPanel({ taskId, sourcePath, onStatusChange, onBridgeReady }: LoamVideoPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FilmcraftBridge | null>(null);
  const importedRef = useRef<string | null>(null);
  const [status, setStatus] = useState<LoamVideoBridgeStatus>('loading');

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

  return (
    <div className="relative h-full w-full bg-black">
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
  );
}

export default LoamVideoPanel;
