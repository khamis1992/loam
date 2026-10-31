'use client';

import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Clapperboard, Loader2, MonitorPlay, Waypoints, X } from 'lucide-react';
import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { useAppSelector } from '@/store';
import { ChatSocket, shortUid } from '@/services/chatSocket';
import { getApiBase, getApiHeaders, getSessionToken } from '@/services/rpc';
import {
  extensionOf,
  getEditorForFile,
  getEditorForKind,
  getEditorForPath,
  subscribeWorkspaceEditors,
  workspaceEditorsVersion,
} from './registry';
import {
  LOAM_VIDEO_STUDIO_PATH,
  CANVAS_RUN_PATH,
  type WorkspaceEditorDef,
  type WorkspaceEditorProps,
  type WorkspaceFile,
  type WorkspaceKind,
} from './types';
import { EditorFallbackCard, EditorOverrideMenu, editorLabel } from './gateway';

function getSocketBase(): string {
  if (typeof window === 'undefined') return '/';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.socketBase) return injected.socketBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return 'http://localhost:8787';
  return '/';
}

/** Shell-owned per-file panel: resolves the registered editor for a workspace file, forwards
 *  onSave to the per-kind save endpoint and onChatEdit onto the task's chat. */
export function WorkspaceFilePanel({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
  const def = getEditorForFile(file);
  const [Editor, setEditor] = useState<null | React.ComponentType<WorkspaceEditorProps>>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);

  const live = useAppSelector((s) => (s.chat.running[file.taskId] ?? false));

  useEffect(() => {
    let cancelled = false;
    if (!def) return;
    def.load()
      .then((module) => { if (!cancelled) setEditor(() => module.default); })
      .catch(() => { if (!cancelled) setLoadError(t('Failed to load the editor.')); });
    return () => { cancelled = true; };
  }, [def]);

  // Chat edit channel: dedicated socket for the panel; the shell may replace this with
  // the shared thread socket once integrated into the task right panel.
  useEffect(() => {
    const socket = new ChatSocket({
      getToken: getSessionToken,
      socketBase: getSocketBase(),
      onMessage: () => { /* events render in the main thread view */ },
    });
    socketRef.current = socket;
    let active = true;
    void socket.connect().then(() => { if (active) socket.join(file.taskId, shortUid()); }).catch(() => { /* send retries below */ });
    return () => {
      active = false;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [file.taskId]);

  if (!def) {
    // The gateway's honest fallback: no editor claims this type, so the card
    // shows the file's basic info and a download instead of a broken editor.
    return (
      <aside className="flex h-full w-full flex-col border-s border-border-main bg-bg-menu">
        <EditorFallbackCard file={file} apiBase={getApiBase()} />
      </aside>
    );
  }

  const handleSave = async (data: Blob | string): Promise<void> => {
    const url = `${getApiBase()}/api/workspace/${def.kind}/file?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`;
    const headers = await getApiHeaders();
    if (typeof data === 'string') {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ html: data }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `Save failed (${response.status})`);
      }
      return;
    }
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'content-type': data.type || 'application/octet-stream' },
      body: data,
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `Save failed (${response.status})`);
    }
  };

  const handleChatEdit = (instruction: string): void => {
    const message = `Edit ${file.path}: ${instruction}`;
    const socket = socketRef.current;
    if (!socket) return;
    if (socket.isConnected()) {
      socket.sendText(file.taskId, message, 'standard');
      return;
    }
    void socket
      .connect()
      .then(() => {
        socket.join(file.taskId);
        socket.sendText(file.taskId, message, 'standard');
      })
      .catch(() => undefined);
  };

  return (
    <aside className="flex h-full w-full flex-col border-s border-border-main bg-bg-menu">
      <div className="flex h-row items-center justify-between border-b border-border-main px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{file.name}</p>
          <p className="text-[11px] text-text-tertiary">{editorLabel(def, file)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
          aria-label={t('Close')}
        >
          <X className="size-4" />
        </button>
      </div>
      {Editor ? (
        <Editor file={file} live={live} onSave={handleSave} onChatEdit={handleChatEdit} />
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-secondary">
          {loadError ? <p className="text-function-error">{loadError}</p> : <><Loader2 className="size-4 animate-spin" /> {t('Loading')}</>}
        </div>
      )}
    </aside>
  );
}

export interface WorkspacePanelProps {
  taskId: string;
  live: boolean; // task running
  events: ChatEvent[];
  requestedPath?: string | null;
  /** Editor kind the auto-open decision asked for (e.g. loam-video). */
  requestedKind?: WorkspaceKind | null;
  onChatEdit: (instruction: string, file: WorkspaceFile) => void;
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  // Loam Craft apps (cr-03): the extra formats the vendored editors open.
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  psd: 'image/vnd.adobe.photoshop',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  idml: 'application/vnd.adobe.indesign-idml-package',
  indd: 'application/x-indesign',
  pdf: 'application/pdf',
};

interface FileEntry {
  name: string;
  path: string;
  dir?: boolean;
  size?: number;
  mtimeMs?: number;
}

/** A listed file no editor claims; the gateway shows its fallback card for it. */
interface UnresolvedFile {
  path: string;
  name: string;
  size?: number;
}

function toWorkspaceFile(taskId: string, entry: FileEntry, def: WorkspaceEditorDef): WorkspaceFile {
  const ext = extensionOf(entry.path);
  return {
    taskId,
    path: entry.path,
    name: entry.name || (entry.path.split(/[\\/]/).pop() ?? entry.path),
    kind: def.kind,
    mime: MIME_BY_EXT[ext],
  };
}

export function WorkspacePanel({ taskId, live, events, requestedPath, requestedKind, onChatEdit }: WorkspacePanelProps) {
  const apiBase = useMemo(() => getApiBase(), []);
  const version = useSyncExternalStore(subscribeWorkspaceEditors, workspaceEditorsVersion, workspaceEditorsVersion);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [unresolvedFiles, setUnresolvedFiles] = useState<UnresolvedFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const lastTool = useMemo(
    () => [...events].reverse().find((e): e is ToolUsedEvent => e.type === 'toolUsed'),
    [events],
  );

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const headers = await getApiHeaders();
        const params = new URLSearchParams({ taskId, path: '', max: '400' });
        const res = await fetch(`${apiBase}/api/files?${params.toString()}`, { headers });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { entries?: FileEntry[] };
        const mapped: Array<WorkspaceFile & { mtimeMs: number }> = [];
        const unresolved: UnresolvedFile[] = [];
        for (const e of data.entries ?? []) {
          if (e.dir) continue;
          const def = getEditorForPath(e.path);
          if (def) {
            mapped.push({ ...toWorkspaceFile(taskId, e, def), mtimeMs: e.mtimeMs ?? 0 });
          } else if (extensionOf(e.path)) {
            // The gateway tracks these so an auto-open (or the user) can still
            // select one and see the honest fallback card.
            unresolved.push({
              path: e.path,
              name: e.name || (e.path.split(/[\\/]/).pop() ?? e.path),
              size: e.size,
            });
          }
        }
        // Newest modified files first so the live artifact surfaces on top.
        mapped.sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (!cancelled) {
          setFiles(mapped.map(({ mtimeMs: _mtimeMs, ...file }) => file));
          setUnresolvedFiles(unresolved);
        }
      } catch {
        if (!cancelled) {
          setFiles([]);
          setUnresolvedFiles([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // version: registrations land asynchronously; lastTool: refresh when the task touches files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, taskId, lastTool?.timestamp, version]);

  // Auto-open override: applies once per distinct target so a manual file
  // selection is never clobbered by a stale requestedPath.
  const autoOpenKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedKind && !requestedPath) return;
    const key = `${requestedKind ?? ''}:${requestedPath ?? ''}`;
    if (autoOpenKeyRef.current === key) return;
    autoOpenKeyRef.current = key;
    if (requestedKind === 'loam-video') {
      const match = requestedPath ? files.find((f) => f.path === requestedPath) : undefined;
      if (match) setSelectedPath(match.path);
      else if (requestedPath) setSelectedPath(requestedPath);
      else {
        const firstVideo = files.find((f) => getEditorForPath(f.path)?.kind === 'loam-video');
        setSelectedPath(firstVideo ? firstVideo.path : LOAM_VIDEO_STUDIO_PATH);
      }
      return;
    }
    // Craft apps: the decision names a file and/or the app. Open the named file,
    // otherwise the newest file the craft editor owns.
    if (requestedKind === 'craft') {
      const match = requestedPath ? files.find((f) => f.path === requestedPath) : undefined;
      if (match) {
        setSelectedPath(match.path);
        return;
      }
      const firstCraft = files.find((f) => getEditorForPath(f.path)?.kind === 'craft');
      if (firstCraft) setSelectedPath(firstCraft.path);
      return;
    }
    // The Canvas tab is task-wide (the run graph), so there is no file to
    // match: any request for it selects the canvas sentinel.
    if (requestedKind === 'canvas') {
      setSelectedPath(CANVAS_RUN_PATH);
      return;
    }
    if (requestedPath && files.some((f) => f.path === requestedPath)) setSelectedPath(requestedPath);
    // Gateway honesty: the requested file has no editor, so open it on the
    // fallback card instead of silently selecting a different file.
    else if (requestedPath && !getEditorForPath(requestedPath)) setSelectedPath(requestedPath);
    else if (requestedPath && files.length > 0) setSelectedPath(files[0].path);
  }, [files, requestedPath, requestedKind]);

  // Default selection + keep the selection valid as the file list changes.
  useEffect(() => {
    if (!selectedPath && files.length > 0) {
      setSelectedPath(files[0].path);
      return;
    }
    // A workspace that produced only uneditable files still shows something
    // honest: the newest one's fallback card.
    if (!selectedPath && files.length === 0 && unresolvedFiles.length > 0) {
      setSelectedPath(unresolvedFiles[0].path);
      return;
    }
    if (
      selectedPath &&
      files.length > 0 &&
      !files.some((f) => f.path === selectedPath) &&
      selectedPath !== LOAM_VIDEO_STUDIO_PATH &&
      selectedPath !== CANVAS_RUN_PATH &&
      selectedPath !== requestedPath
    ) {
      setSelectedPath(files[0].path);
    }
  }, [files, unresolvedFiles, selectedPath, requestedPath]);

  const selected = useMemo(() => {
    if (selectedPath === LOAM_VIDEO_STUDIO_PATH) {
      return { taskId, path: LOAM_VIDEO_STUDIO_PATH, name: t('Loam Video'), kind: 'loam-video' as const };
    }
    if (selectedPath === CANVAS_RUN_PATH) {
      return { taskId, path: CANVAS_RUN_PATH, name: t('Canvas'), kind: 'canvas' as const };
    }
    return files.find((f) => f.path === selectedPath) ?? null;
  }, [files, selectedPath, taskId]);

  const def = useMemo(() => (selected ? getEditorForFile(selected) : null), [selected]);
  const loamVideoDef = getEditorForKind('loam-video');
  const canvasDef = getEditorForKind('canvas');

  // The gateway fallback: the selection is a real file path that no editor
  // claims (auto-opened, e.g. a tool output with an exotic extension), so the
  // panel shows the honest card for it instead of an editor.
  const unresolvedSelection = useMemo(() => {
    if (!selectedPath || selectedPath === LOAM_VIDEO_STUDIO_PATH || selectedPath === CANVAS_RUN_PATH) return null;
    if (selected) return null;
    if (getEditorForPath(selectedPath)) return null;
    if (!extensionOf(selectedPath)) return null;
    const listed = unresolvedFiles.find((f) => f.path === selectedPath);
    return {
      taskId,
      path: selectedPath,
      name: listed?.name ?? (selectedPath.split(/[\\/]/).pop() ?? selectedPath),
      size: listed?.size,
    };
  }, [selected, selectedPath, unresolvedFiles, taskId]);

  const onSave = useMemo(() => {
    if (!selected) return async () => undefined;
    return async (data: Blob | string) => {
      const headers = await getApiHeaders();
      const params = new URLSearchParams({ taskId: selected.taskId, path: selected.path });
      // The doc route parses a JSON { html } body; other kinds keep their raw payload
      // (the sheet editor already passes serialized JSON text its own route parses).
      const asDocJson = selected.kind === 'doc' && typeof data === 'string';
      const res = await fetch(`${apiBase}/api/workspace/${selected.kind}/file?${params.toString()}`, {
        method: 'PUT',
        headers: {
          ...headers,
          ...(asDocJson
            ? { 'content-type': 'application/json' }
            : typeof data === 'string'
              ? { 'content-type': 'text/plain' }
              : { 'content-type': 'application/octet-stream' }),
        },
        body: asDocJson ? JSON.stringify({ html: data }) : data,
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
    };
  }, [apiBase, selected]);

  const EditorComponent = useMemo(() => {
    if (!def) return null;
    return lazy(def.load);
    // Remount per file so editors re-read their content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, selected?.path]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-main bg-bg-menu px-3 py-1.5">
        <span
          aria-hidden="true"
          className={live ? 'size-2 shrink-0 animate-pulse rounded-full bg-[var(--icon-blue)]' : 'size-2 shrink-0 rounded-full bg-text-quaternary'}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {live
            ? lastTool
              ? t('Running {tool}', { tool: lastTool.tool }) + (lastTool.brief ? ` — ${lastTool.brief}` : '')
              : t('Working')
            : lastTool
              ? t('Last tool: {tool}', { tool: lastTool.tool })
              : t('Workspace')}
        </span>
        {loading && <Loader2 className="size-3.5 animate-spin text-text-tertiary" />}
        {selected && selectedPath !== LOAM_VIDEO_STUDIO_PATH && selectedPath !== CANVAS_RUN_PATH && (
          <EditorOverrideMenu file={selected} />
        )}
      </div>

      {(files.length > 1 || loamVideoDef || canvasDef) && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-main px-2 py-1.5">
          {canvasDef && (
            <button
              type="button"
              onClick={() => setSelectedPath(CANVAS_RUN_PATH)}
              title={t('Canvas')}
              className={
                selectedPath === CANVAS_RUN_PATH
                  ? 'flex items-center gap-1 whitespace-nowrap rounded-control bg-fill-tsp px-2 py-1 text-xs font-medium text-text-primary'
                  : 'flex items-center gap-1 whitespace-nowrap rounded-control px-2 py-1 text-xs text-text-tertiary hover:bg-fill-hover hover:text-text-secondary'
              }
            >
              <Waypoints className="size-3" />
              {t('Canvas')}
            </button>
          )}
          {loamVideoDef && (
            <button
              type="button"
              onClick={() => setSelectedPath(LOAM_VIDEO_STUDIO_PATH)}
              title={t('Loam Video')}
              className={
                selectedPath === LOAM_VIDEO_STUDIO_PATH
                  ? 'flex items-center gap-1 whitespace-nowrap rounded-control bg-fill-tsp px-2 py-1 text-xs font-medium text-text-primary'
                  : 'flex items-center gap-1 whitespace-nowrap rounded-control px-2 py-1 text-xs text-text-tertiary hover:bg-fill-hover hover:text-text-secondary'
              }
            >
              <Clapperboard className="size-3" />
              {t('Loam Video')}
            </button>
          )}
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => setSelectedPath(f.path)}
              title={f.path}
              className={
                f.path === selectedPath
                  ? 'flex items-center gap-1 whitespace-nowrap rounded-control bg-fill-tsp px-2 py-1 text-xs font-medium text-text-primary'
                  : 'flex items-center gap-1 whitespace-nowrap rounded-control px-2 py-1 text-xs text-text-tertiary hover:bg-fill-hover hover:text-text-secondary'
              }
            >
              <MonitorPlay className="size-3" />
              {f.name}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {EditorComponent && selected ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-sm text-text-tertiary">
                <Loader2 className="size-4 animate-spin" /> {t('Loading')}
              </div>
            }
          >
            <EditorComponent
              file={selected}
              live={live}
              onSave={onSave}
              onChatEdit={(instruction: string) => onChatEdit(instruction, selected)}
              events={events}
            />
          </Suspense>
        ) : unresolvedSelection ? (
          <EditorFallbackCard
            file={unresolvedSelection}
            size={unresolvedSelection.size}
            apiBase={apiBase}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <MonitorPlay className="size-8 text-text-quaternary" />
            <p className="text-sm text-text-tertiary">
              {files.length === 0
                ? t('The workspace is empty. Files the task creates or edits will open here.')
                : t('Select a file to edit')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
