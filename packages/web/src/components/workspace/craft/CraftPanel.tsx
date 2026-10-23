'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, Save, X } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { CRAFT_APPS, CraftBridge, type CraftApp, type CraftReady, type CraftSave } from '@/lib/craftBridge';
import type { WorkspaceEditorProps, WorkspaceFile, WorkspaceKind } from '../types';
import { isPreviewOnlyExt, unsupportedNoticeFor } from '../craft';

/** How long the embedded app gets to announce `craft:ready` before we fall back. */
export const CRAFT_READY_TIMEOUT_MS = 20_000;

type PanelStatus = 'loading' | 'ready' | 'error' | 'fallback';

/** The built-in editor component used when the Craft app is not available. */
export type CraftFallbackEditor = React.ComponentType<WorkspaceEditorProps>;

export interface CraftPanelProps {
  taskId: string;
  app: CraftApp;
  /** Path of the task file to open as soon as the app is ready. */
  path: string;
  onClose: () => void;
  /** Render the built-in fallback instead of the Craft app (tests / non-Electron). */
  forceFallback?: boolean;
  /** Fetch the file that is opened in the editor. */
  fetchBytes?: (path: string) => Promise<Uint8Array>;
  /** Store saved bytes in the task's files. */
  uploadBytes?: (taskId: string, name: string, bytes: Uint8Array) => Promise<void>;
  /** Lazily load the built-in editor for a fallback kind. */
  loadFallback?: (kind: WorkspaceKind) => Promise<CraftFallbackEditor | null>;
  /**
   * Hide the panel's own header. The workspace shell already renders one (file
   * name + close), so the craft editor hides its duplicate when hosted there.
   */
  hideHeader?: boolean;
  /** Report the panel status so the owning workspace editor can react (cr-03). */
  onStatusChange?: (status: PanelStatus) => void;
  /** Notify the host about every save (name + bytes) it should store (cr-03). */
  onSave?: (name: string, bytes: Uint8Array) => void;
}

/** Task-file status from the cr-01 endpoint; a 404 (or a network error) means unknown. */
interface CraftStatus {
  ok: boolean;
  apps?: Partial<Record<CraftApp, { present?: boolean }>>;
  missing?: string[];
}

/** One mounted Craft editor, keyed by the task + app it belongs to. */
export interface CraftBridgeEntry {
  bridge: CraftBridge;
  ready: CraftReady | null;
}

const bridges = new Map<string, CraftBridgeEntry>();
const bridgeListeners = new Set<() => void>();

function notifyBridges(): void {
  for (const listener of bridgeListeners) {
    try {
      listener();
    } catch {
      /* a listener failure must not break registration */
    }
  }
}

function bridgeKey(taskId: string, app: CraftApp): string {
  return `${taskId}\u0000${app}`;
}

/**
 * The bridge the mounted CraftPanel created for one task + app, so agent tools
 * (cr-04) can drive the live editor without holding an iframe reference.
 * Returns null when that editor is not mounted right now.
 */
export function getCraftBridge(taskId: string, app: CraftApp): CraftBridge | null {
  return bridges.get(bridgeKey(taskId, app))?.bridge ?? null;
}

/** Subscribe to Craft bridge registrations. Returns an unsubscribe function. */
export function subscribeCraftBridges(listener: () => void): () => void {
  bridgeListeners.add(listener);
  return () => bridgeListeners.delete(listener);
}

/**
 * Register (or clear) the bridge for one task + app. Called by the CraftPanel on
 * mount and unmount; safe to call repeatedly.
 */
export function registerCraftBridge(
  taskId: string,
  app: CraftApp,
  entry: CraftBridgeEntry | null,
): void {
  const key = bridgeKey(taskId, app);
  if (entry) bridges.set(key, entry);
  else bridges.delete(key);
  notifyBridges();
}

/** The `loamcraft://` URL of one editor build. Only resolves inside Electron. */
export function craftFrameUrl(app: CraftApp): string {
  return `loamcraft://${CRAFT_APPS[app].internalId}/index.html?loam=1`;
}

/** The built-in editor kind for one Craft app (Photo and Design have none). */
export function fallbackKindFor(app: CraftApp): WorkspaceKind | null {
  switch (app) {
    case 'docs':
      return 'doc';
    case 'sheets':
      return 'sheet';
    case 'slides':
      return 'slides';
    default:
      return null;
  }
}

/** Ask the server which Craft dists are installed (cr-01). 404 = unknown. */
export async function fetchCraftStatus(): Promise<CraftStatus> {
  try {
    const res = await fetch(`${getApiBase()}/api/craft/status`, { headers: await getApiHeaders() });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as CraftStatus;
    return { ok: true, apps: data.apps, missing: data.missing };
  } catch {
    return { ok: false };
  }
}

/** Read one task file's raw bytes through the media endpoint (serves any extension). */
export async function fetchTaskFileBytes(taskId: string, path: string): Promise<Uint8Array> {
  const params = new URLSearchParams({ taskId, path });
  const res = await fetch(`${getApiBase()}/api/media?${params.toString()}`, {
    headers: await getApiHeaders(),
  });
  if (!res.ok) throw new Error(`failed to fetch ${path} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** MIME type used when storing saved bytes, derived from the file extension. */
export function craftSaveMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':
      return 'application/msword';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'csv':
      return 'text/csv';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'odp':
      return 'application/vnd.oasis.opendocument.presentation';
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'psd':
      return 'image/vnd.adobe.photoshop';
    default:
      return 'application/octet-stream';
  }
}

/**
 * The Craft editor panel: embeds one vendored Loam Craft app, drives it through
 * the `craft:*` bridge and falls back to the built-in editor when the app is not
 * installed or never becomes ready.
 */
export function CraftPanel({
  taskId,
  app,
  path,
  onClose,
  forceFallback,
  fetchBytes = (filePath) => fetchTaskFileBytes(taskId, filePath),
  uploadBytes = uploadSave,
  loadFallback = defaultLoadFallback,
  hideHeader = false,
  onStatusChange,
  onSave,
}: CraftPanelProps) {
  const info = CRAFT_APPS[app];
  const fallbackKind = fallbackKindFor(app);
  const notice = unsupportedNoticeFor(path);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<CraftBridge | null>(null);

  const [status, setStatus] = useState<PanelStatus>(forceFallback ? 'fallback' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [Fallback, setFallback] = useState<CraftFallbackEditor | null>(null);

  // Store one `craft:save` in the task's files (the existing task-files API).
  const storeSave = useCallback(
    async (save: CraftSave) => {
      setSaving(true);
      setError(null);
      try {
        await uploadBytes(taskId, save.name, save.bytes);
        onSave?.(save.name, save.bytes);
        setSavedName(save.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [onSave, taskId, uploadBytes],
  );

  // Save from a built-in fallback editor through its per-kind file endpoint.
  const storeFallbackSave = useCallback(
    async (data: Blob | string) => {
      if (!fallbackKind) return;
      setSaving(true);
      setError(null);
      try {
        const params = new URLSearchParams({ taskId, path });
        const url = `${getApiBase()}/api/workspace/${fallbackKind}/file?${params.toString()}`;
        const res = await fetch(url, {
          method: 'PUT',
          headers: {
            ...(await getApiHeaders()),
            'content-type': typeof data === 'string' ? 'text/plain' : data.type || 'application/octet-stream',
          },
          body: data,
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(detail.error ?? `save failed (${res.status})`);
        }
        setSavedName(path.split(/[\\/]/).pop() ?? path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [fallbackKind, path, taskId],
  );

  // Report the panel status to the owning workspace editor (cr-03).
  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  // Whether the Craft dist for this app is installed at all (cr-01 endpoint).
  useEffect(() => {
    if (forceFallback) return;
    let cancelled = false;
    void (async () => {
      const status = await fetchCraftStatus();
      if (cancelled) return;
      const missing = status.missing ?? [];
      const appMissing = status.apps?.[app]?.present === false || missing.includes(app);
      if (!status.ok || appMissing) setStatus((prev) => (prev === 'ready' ? prev : 'fallback'));
    })();
    return () => {
      cancelled = true;
    };
  }, [app, forceFallback]);

  // Mount the bridge for this iframe and wait for the app to become ready.
  useEffect(() => {
    if (forceFallback) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const bridge = new CraftBridge(iframe);
    bridgeRef.current = bridge;
    registerCraftBridge(taskId, app, { bridge, ready: null });
    let disposed = false;

    bridge
      .waitReady(CRAFT_READY_TIMEOUT_MS)
      .then((ready) => {
        if (disposed) return;
        registerCraftBridge(taskId, app, { bridge, ready });
        setStatus('ready');
      })
      .catch(() => {
        if (disposed) return;
        setStatus('fallback');
        setError(t('The Craft editor did not start, so the built-in editor is open instead.'));
      });

    const unsubscribeSave = bridge.onSave((save) => {
      void storeSave(save);
    });

    return () => {
      disposed = true;
      unsubscribeSave();
      bridgeRef.current = null;
      registerCraftBridge(taskId, app, null);
      bridge.dispose();
    };
  }, [app, forceFallback, storeSave, taskId]);

  // Open the task file once the app is ready.
  useEffect(() => {
    if (status !== 'ready' || !path) return;
    const bridge = bridgeRef.current;
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await fetchBytes(path);
        if (cancelled || !bridgeRef.current) return;
        bridge.open(path.split(/[\\/]/).pop() ?? path, bytes);
      } catch {
        /* nothing to open: the app simply starts empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchBytes, path, status]);

  // Load the built-in editor for the fallback path.
  useEffect(() => {
    if (status !== 'fallback' || !fallbackKind) return;
    let cancelled = false;
    void loadFallback(fallbackKind)
      .then((component) => {
        if (!cancelled) setFallback(() => component);
      })
      .catch(() => {
        if (!cancelled) setFallback(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fallbackKind, loadFallback, status]);

  const handleSave = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    setSaving(true);
    setError(null);
    try {
      // The app hands the bytes back over craft:save, which storeSave uploads.
      await bridge.execute('file.save');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const fallbackFile: WorkspaceFile = {
    taskId,
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    kind: fallbackKind ?? 'doc',
  };

  // Preview-only types (`.indd` upstream limitation): never embed the app, show the
  // notice and the media preview instead, so the user is not left with a broken editor.
  if (isPreviewOnlyExt(path)) {
    return (
      <div className="flex h-full w-full flex-col border-s border-border-main bg-bg-menu text-sm text-text-secondary">
        {hideHeader ? null : (
          <PanelHeader
            name={info.displayName}
            statusLabel={t('Preview only')}
            status="fallback"
            saving={false}
            onClose={onClose}
          />
        )}
        <div className="flex items-center gap-2 border-b border-border-main px-4 py-2 text-[11px] text-function-warning">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <CraftPreview file={fallbackFile} />
        </div>
      </div>
    );
  }

  if (status === 'fallback' || forceFallback) {
    return (
      <div className="flex h-full w-full flex-col border-s border-border-main bg-bg-menu text-sm text-text-secondary">
        {hideHeader ? null : (
          <PanelHeader name={info.displayName} statusLabel={error ?? t('Built-in editor')} status={status} saving={saving} onClose={onClose} />
        )}
        {error && (
          <div className="flex items-center gap-2 border-b border-border-main px-4 py-2 text-[11px] text-text-tertiary">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          {fallbackKind && Fallback ? (
            <Fallback file={fallbackFile} live={false} onSave={storeFallbackSave} onChatEdit={() => undefined} />
          ) : fallbackKind ? (
            <div className="flex h-full items-center justify-center gap-2 text-text-tertiary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          ) : (
            <CraftPreview file={fallbackFile} />
          )}
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex h-full w-full flex-col border-s border-border-main bg-bg-menu">
        {hideHeader ? null : (
          <PanelHeader
            name={info.displayName}
            statusLabel={error ?? t('The editor could not be loaded.')}
            status={status}
            saving={saving}
            onClose={onClose}
          />
        )}
        <div className="flex flex-1 items-center justify-center gap-2 text-text-secondary">
          <AlertCircle className="size-5" />
          <p>{error ?? t('The editor could not be loaded.')}</p>
        </div>
      </div>
    );
  }

  // While the app is still loading the iframe is mounted but dimmed behind an
  // overlay, so the embedded editor can announce `craft:ready` at any moment.
  const loading = status === 'loading';

  return (
    <div className="flex h-full w-full flex-col border-s border-border-main bg-bg-menu">
      {hideHeader ? null : (
        <PanelHeader
          name={info.displayName}
          statusLabel={error ?? (loading ? t('Loading {name}', { name: info.displayName }) : t('Ready'))}
          status={loading ? 'loading' : status}
          saving={saving}
          onClose={onClose}
          onSave={() => void handleSave()}
        />
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <iframe
          ref={iframeRef}
          src={craftFrameUrl(app)}
          title={info.displayName}
          className="h-full w-full border-0"
          allow="autoplay; fullscreen"
        />
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-menu/90 text-text-secondary">
            <Loader2 className="size-5 animate-spin" />
            <p>{t('Loading {name}', { name: info.displayName })}</p>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border-main px-4 py-1.5 text-[11px] text-text-tertiary">
        {savedName ? (
          <>
            <CheckCircle className="size-3.5 text-function-success" />
            <span className="truncate">{t('Saved {name}', { name: savedName })}</span>
          </>
        ) : (
          <span className="truncate">{t('Changes are saved into the task files.')}</span>
        )}
      </div>
    </div>
  );
}

/** Slim panel header: app name, status and the actions that apply to it. */
function PanelHeader({
  name,
  statusLabel,
  status,
  saving,
  onClose,
  onSave,
}: {
  name: string;
  statusLabel: string;
  status: PanelStatus;
  saving: boolean;
  onClose: () => void;
  onSave?: () => void;
}) {
  return (
    <div className="flex h-row shrink-0 items-center justify-between border-b border-border-main px-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">{name}</p>
        <p className="truncate text-[11px] text-text-tertiary" title={statusLabel}>
          {statusLabel}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {status === 'ready' && onSave && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-control bg-fill-tsp px-3 py-1.5 text-sm text-text-primary hover:bg-fill-hover disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {t('Save to task files')}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
          aria-label={t('Close')}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Preview-only fallback for the apps with no built-in editor (Photo, Design). */
export function CraftPreview({ file }: { file: WorkspaceFile }) {
  const src = `${getApiBase()}/api/media?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`;
  const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') {
    return <iframe src={src} title={file.name} className="h-full w-full border-0" />;
  }
  if (ext === 'mp4' || ext === 'webm') {
    return <video src={src} controls className="h-full w-full bg-black object-contain" />;
  }
  return (
    <div className="flex h-full items-center justify-center bg-bg-main">
      {/* The media endpoint serves any task file, images included. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={file.name} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

/**
 * Import the built-in editor for a fallback kind. Every import is guarded so a
 * broken or absent editor module never breaks the panel.
 */
export async function defaultLoadFallback(kind: WorkspaceKind): Promise<CraftFallbackEditor | null> {
  switch (kind) {
    case 'doc':
      return (await import('../doc/Editor').catch(() => null))?.default ?? null;
    case 'sheet':
      return (await import('../sheet/Editor').catch(() => null))?.default ?? null;
    case 'slides':
      return (await import('../slides/Editor').catch(() => null))?.default ?? null;
    default:
      return null;
  }
}

/** Store saved bytes in the task's files through the existing upload endpoint. */
async function uploadSave(taskId: string, name: string, bytes: Uint8Array): Promise<void> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: craftSaveMime(name) });
  const params = new URLSearchParams({ taskId, name });
  const res = await fetch(`${getApiBase()}/api/upload?${params.toString()}`, {
    method: 'POST',
    headers: await getApiHeaders(),
    body: blob,
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `upload failed (${res.status})`);
  }
}
