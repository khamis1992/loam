'use client';

import { Suspense, lazy, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Loader2, MonitorPlay } from 'lucide-react';
import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import {
  extensionOf,
  getEditorForPath,
  subscribeWorkspaceEditors,
  workspaceEditorsVersion,
  type WorkspaceEditorDef,
  type WorkspaceFile,
} from './index';

export interface WorkspacePanelProps {
  taskId: string;
  live: boolean; // task running
  events: ChatEvent[];
  requestedPath?: string | null;
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
};

interface FileEntry {
  name: string;
  path: string;
  dir?: boolean;
  size?: number;
  mtimeMs?: number;
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

export function WorkspacePanel({ taskId, live, events, requestedPath, onChatEdit }: WorkspacePanelProps) {
  const apiBase = useMemo(() => getApiBase(), []);
  const version = useSyncExternalStore(subscribeWorkspaceEditors, workspaceEditorsVersion, workspaceEditorsVersion);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
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
        for (const e of data.entries ?? []) {
          if (e.dir) continue;
          const def = getEditorForPath(e.path);
          if (def) mapped.push({ ...toWorkspaceFile(taskId, e, def), mtimeMs: e.mtimeMs ?? 0 });
        }
        // Newest modified files first so the live artifact surfaces on top.
        mapped.sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (!cancelled) setFiles(mapped.map(({ mtimeMs: _mtimeMs, ...file }) => file));
      } catch {
        if (!cancelled) setFiles([]);
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

  useEffect(() => {
    if (requestedPath && files.some((f) => f.path === requestedPath)) {
      setSelectedPath(requestedPath);
      return;
    }
    if (requestedPath && files.length > 0 && !files.some((f) => f.path === requestedPath)) {
      setSelectedPath(files[0]?.path ?? null);
      return;
    }
    if (!selectedPath && files.length > 0) setSelectedPath(files[0].path);
    if (selectedPath && files.length > 0 && !files.some((f) => f.path === selectedPath)) {
      setSelectedPath(files[0].path);
    }
  }, [files, requestedPath, selectedPath]);

  const selected = useMemo(() => files.find((f) => f.path === selectedPath) ?? null, [files, selectedPath]);
  const def = selected ? getEditorForPath(selected.path) : null;

  const onSave = useMemo(() => {
    if (!selected) return async () => undefined;
    return async (data: Blob | string) => {
      const headers = await getApiHeaders();
      const body = data;
      const params = new URLSearchParams({ taskId: selected.taskId, path: selected.path });
      const res = await fetch(`${apiBase}/api/workspace/${selected.kind}/file?${params.toString()}`, {
        method: 'PUT',
        headers: {
          ...headers,
          ...(typeof data === 'string' ? { 'content-type': 'text/plain' } : { 'content-type': 'application/octet-stream' }),
        },
        body,
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
      </div>

      {files.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-main px-2 py-1.5">
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
            />
          </Suspense>
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
