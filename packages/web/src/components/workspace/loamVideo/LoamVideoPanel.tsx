'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2, Sparkles, Video } from 'lucide-react';
import { t } from '@/i18n/t';
import { FilmcraftBridge, FILMCRAFT_FRAME_URL, type FilmcraftMethod } from '@/lib/filmcraft';
import { setLoamVideoTarget } from '@/lib/filmcraftClient';
import { exportLoamVideo, type LoamVideoExportProgress } from '@/lib/videoStudioExport';
import { EffectcraftBridge, EFFECTCRAFT_FRAME_URL, type EffectcraftMethod } from '@/lib/effectcraft';
import { setLoamEffectsTarget } from '@/lib/effectcraftClient';
import {
  planReopenEffects,
  planReturnToFilm,
  readEffectsProjectPath,
  selectPanelClip,
  parseFilmState,
  effectsProjectPathFor,
} from '@shared/effectsRoundTrip';

export type LoamVideoBridgeStatus = 'loading' | 'ready' | 'unavailable';

/** Which engine the panel is showing. Loam Effects is the hidden backend. */
export type LoamVideoEngine = 'video' | 'effects';

/** Availability of the hidden effects backend, for the "Open in effects" button. */
export type LoamEffectsAvailability = 'loading' | 'available' | 'unavailable';

export interface LoamVideoPanelProps {
  /** Task that owns the studio; reported to the fc-02 client hook. */
  taskId?: string;
  /** Task-workspace video path imported automatically once the studio is ready. */
  sourcePath?: string | null;
  /** Notified whenever the editor API availability changes. */
  onStatusChange?: (status: LoamVideoBridgeStatus) => void;
  /** Notified with the bridge once the editor API is ready. */
  onBridgeReady?: (bridge: FilmcraftBridge) => void;
  /** Notified with the engine the panel is showing (video or effects). */
  onEngineChange?: (engine: LoamVideoEngine) => void;
  /** Notified when the effects backend becomes available or is missing. */
  onEffectsAvailabilityChange?: (availability: LoamEffectsAvailability) => void;
  /**
   * A `.ecproj` to reopen in the effects engine, e.g. one an agent round trip
   * just saved. When set, the panel switches to the effects engine and reopens
   * that project, so the user can keep editing it.
   */
  reopenProjectPath?: string | null;
  /** Notified after the effects engine reports the project it now holds. */
  onProjectPathChange?: (projectPath: string | null) => void;
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
 * It also owns the hidden "Loam Effects" engine, which is mounted in a second
 * iframe so the two engines never fight over the same element. "Open in
 * effects" switches to it; "Done" brings the re-rendered clip back.
 *
 * Used by the `/app/video` page and the `loam-video` Workspace panel editor.
 * Rendering the iframe is safe even when the vendored dist is missing — the
 * host decides what to show for the `unavailable` status.
 *
 * The Export button renders the timeline through the server (fc-06) and saves
 * the file into the task's files; it needs a taskId, so it stays hidden on the
 * standalone `/app/video` page.
 */
export function LoamVideoPanel({
  taskId,
  sourcePath,
  onStatusChange,
  onBridgeReady,
  onEngineChange,
  onEffectsAvailabilityChange,
  reopenProjectPath,
  onProjectPathChange,
}: LoamVideoPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const effectsIframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FilmcraftBridge | null>(null);
  const effectsBridgeRef = useRef<EffectcraftBridge | null>(null);
  const filmStateRef = useRef<unknown>(null);
  const filmCatalogRef = useRef<string[]>([]);
  const importedRef = useRef<string | null>(null);
  const [status, setStatus] = useState<LoamVideoBridgeStatus>('loading');
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const [effectsStatus, setEffectsStatus] = useState<LoamVideoBridgeStatus>('loading');
  const [engine, setEngine] = useState<LoamVideoEngine>('video');
  const [effectsAvailability, setEffectsAvailability] = useState<LoamEffectsAvailability>('loading');
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Keep latest callbacks in refs so a parent re-render never remounts the bridge.
  const statusCb = useRef(onStatusChange);
  statusCb.current = onStatusChange;
  const readyCb = useRef(onBridgeReady);
  readyCb.current = onBridgeReady;
  const engineCb = useRef(onEngineChange);
  engineCb.current = onEngineChange;
  const effectsAvailabilityCb = useRef(onEffectsAvailabilityChange);
  effectsAvailabilityCb.current = onEffectsAvailabilityChange;
  const projectCb = useRef(onProjectPathChange);
  projectCb.current = onProjectPathChange;
  // Read the reopen request through a ref so changing it later does not
  // remount the engines (only a change of path triggers a reopen).
  const reopenRef = useRef(reopenProjectPath);
  reopenRef.current = reopenProjectPath;
  const reopenedRef = useRef<string | null>(null);

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
        // The timeline state and catalog are what "Open in effects" needs to
        // round-trip the selected clip, so read them once the API is up.
        void refreshFilmContext(bridge);
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

  // Mount the effects engine alongside the video engine. Both iframes exist for
  // the panel's lifetime; only the visible one is shown, so switching engines is
  // instant and neither engine loses its project state.
  useEffect(() => {
    const iframe = effectsIframeRef.current;
    if (!iframe) return;
    const bridge = new EffectcraftBridge(iframe);
    effectsBridgeRef.current = bridge;
    let disposed = false;

    bridge
      .waitForApi()
      .then(({ hasApi }) => {
        if (disposed) return;
        setEffectsStatus(hasApi ? 'ready' : 'unavailable');
        const availability: LoamEffectsAvailability = hasApi ? 'available' : 'unavailable';
        setEffectsAvailability(availability);
        effectsAvailabilityCb.current?.(availability);
        if (hasApi) void refreshEffectsProject(bridge);
      })
      .catch(() => {
        if (disposed) return;
        setEffectsStatus('unavailable');
        setEffectsAvailability('unavailable');
        effectsAvailabilityCb.current?.('unavailable');
      });

    return () => {
      disposed = true;
      effectsBridgeRef.current = null;
      setLoamEffectsTarget(null);
      bridge.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reopen a requested project in the effects engine. The request usually
  // arrives before the engine has booted, so retry until the bridge is ready.
  useEffect(() => {
    if (!reopenProjectPath || reopenedRef.current === reopenProjectPath) return;
    let cancelled = false;
    const reopen = async (): Promise<void> => {
      const bridge = effectsBridgeRef.current;
      if (!bridge || effectsStatus !== 'ready') {
        if (!cancelled) window.setTimeout(reopen, 200);
        return;
      }
      reopenedRef.current = reopenProjectPath;
      setBusy(true);
      try {
        for (const step of planReopenEffects(reopenProjectPath)) {
          const value = await bridge.call(step.method as EffectcraftMethod, step.params);
          if (step.method === 'inspect') {
            const path = readEffectsProjectPath(value) ?? reopenProjectPath;
            setProjectPath(path ?? null);
            projectCb.current?.(path ?? null);
          }
        }
        setEngine('effects');
        engineCb.current?.('effects');
        setNotice(null);
      } catch (error) {
        setNotice(errorMessage(error));
      } finally {
        setBusy(false);
      }
    };
    void reopen();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopenProjectPath, effectsStatus]);

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

  // Register the effects engine the same way, so a round trip's effects steps
  // reach the mounted engine rather than failing with "not handled".
  useEffect(() => {
    const bridge = effectsBridgeRef.current;
    if (!taskId || effectsStatus !== 'ready' || !bridge) return;
    setLoamEffectsTarget({
      taskId,
      bridge,
      hasApi: true,
      projectPath,
      openProject: (path: string) => bridge.call('openProject' as EffectcraftMethod, { path }),
    });
    return () => setLoamEffectsTarget(null);
  }, [effectsStatus, projectPath, taskId]);

  /** Read the timeline state and command catalog once the video API is up. */
  const refreshFilmContext = async (bridge: FilmcraftBridge): Promise<void> => {
    try {
      const [state, catalog] = await Promise.all([bridge.inspect(), bridge.commands()]);
      filmStateRef.current = state;
      filmCatalogRef.current = (catalog ?? []).map((entry) =>
        typeof entry === 'string' ? entry : (entry?.id ?? ''),
      );
    } catch {
      /* the editor may not expose inspect/commands; the round trip then refuses
         with a clear message instead of a silent no-op */
    }
  };

  /** Read the project path the effects engine currently holds. */
  const refreshEffectsProject = async (bridge: EffectcraftBridge): Promise<void> => {
    try {
      const info = await bridge.inspect();
      const path = readEffectsProjectPath(info);
      setProjectPath(path ?? null);
      projectCb.current?.(path ?? null);
    } catch {
      /* nothing open yet */
    }
  };

  /**
   * "Open in effects": hand the selected clip to the effects engine and switch
   * to it, so the user can apply a transition, effect or text animation there.
   */
  const openInEffects = async (): Promise<void> => {
    const bridge = effectsBridgeRef.current;
    const film = bridgeRef.current;
    if (!bridge || !film || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      // Re-read the timeline so a manual edit made in the panel is never lost.
      await refreshFilmContext(film);
      const state = parseFilmState(filmStateRef.current);
      const clip = selectPanelClip(state);
      if (!clip) {
        setNotice(t('Select a clip on the timeline first.'));
        return;
      }
      const derived = effectsProjectPathFor(clip, taskId ?? undefined);
      await bridge.addFile(clip.source, clip.inSec, clip.outSec);
      const path = readEffectsProjectPath(await bridge.inspect()) ?? derived ?? null;
      setProjectPath(path);
      projectCb.current?.(path);
      setEngine('effects');
      engineCb.current?.('effects');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  /**
   * "Done": take the rendered output back to the timeline and replace the
   * original range on the same track, so neighbouring clips keep their positions.
   */
  const doneInEffects = async (): Promise<void> => {
    const film = bridgeRef.current;
    const bridge = effectsBridgeRef.current;
    if (!film || !bridge || busy || !projectPath) return;
    setBusy(true);
    setNotice(null);
    try {
      const state = parseFilmState(filmStateRef.current);
      const steps = planReturnToFilm(projectPath, state, filmCatalogRef.current);
      if (isPlanError(steps)) {
        setNotice(steps.error);
        return;
      }
      for (const step of steps) {
        if (step.target === 'effects') {
          await bridge.call(step.method as EffectcraftMethod, step.params);
        } else {
          await film.call(step.method as FilmcraftMethod, step.params);
        }
      }
      setEngine('video');
      engineCb.current?.('video');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

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
      {/* One engine is visible at a time, but both stay mounted so switching is
          instant and neither engine loses its project state. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-main bg-bg-menu px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <Video className="size-3.5" /> {t('Loam Video')}
        </span>
        <span className="text-text-tertiary">·</span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <Sparkles className="size-3.5" /> {t('Loam Effects')}
        </span>
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
        <div className="flex-1" />
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
        {engine === 'video' ? (
          <button
            type="button"
            onClick={() => void openInEffects()}
            disabled={status !== 'ready' || effectsAvailability !== 'available' || busy}
            className="flex h-row-sm items-center gap-1.5 rounded-control bg-fill-tsp px-2.5 text-xs text-text-primary hover:bg-fill-hover disabled:opacity-50"
          >
            <Sparkles className="size-3.5" /> {t('Open in effects')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void doneInEffects()}
            disabled={status !== 'ready' || !projectPath || busy}
            className="flex h-row-sm items-center gap-1.5 rounded-control bg-fill-tsp px-2.5 text-xs text-text-primary hover:bg-fill-hover disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Video className="size-3.5" />} {t('Done')}
          </button>
        )}
      </div>

      {notice && (
        <p className="shrink-0 truncate border-b border-border-main bg-function-warning-tsp px-3 py-1.5 text-xs text-function-warning" title={notice}>
          {notice}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        <iframe
          ref={iframeRef}
          src={FILMCRAFT_FRAME_URL}
          title={t('Loam Video')}
          className={`h-full w-full border-0 ${engine === 'video' ? '' : 'hidden'}`}
          allow="autoplay; fullscreen"
        />
        <iframe
          ref={effectsIframeRef}
          src={EFFECTCRAFT_FRAME_URL}
          title={t('Loam Effects')}
          className={`h-full w-full border-0 ${engine === 'effects' ? '' : 'hidden'}`}
          allow="autoplay; fullscreen"
        />
        {engine === 'video' && status === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-menu">
            <div className="flex items-center gap-2 text-sm text-text-tertiary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          </div>
        )}
        {engine === 'effects' && effectsStatus === 'loading' && (
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

/** Human-readable message for an engine failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a step sequence is the planner's error variant. */
function isPlanError(value: unknown): value is { error: string } {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  return typeof (value as { error?: unknown }).error === 'string';
}

export default LoamVideoPanel;