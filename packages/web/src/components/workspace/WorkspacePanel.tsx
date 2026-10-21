'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { t } from '@/i18n/t';
import { useAppSelector } from '@/store';
import { ChatSocket, shortUid } from '@/services/chatSocket';
import { getApiBase, getApiHeaders, getSessionToken } from '@/services/rpc';
import { getEditorForFile } from './registry';
import type { WorkspaceEditorProps, WorkspaceFile } from './types';

function getSocketBase(): string {
  if (typeof window === 'undefined') return '/';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.socketBase) return injected.socketBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return 'http://localhost:8787';
  return '/';
}

/** Shell-owned panel: resolves the registered editor for a workspace file, forwards
 *  onSave to the per-kind save endpoint and onChatEdit onto the task's chat. */
export function WorkspacePanel({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
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
    return (
      <aside className="flex flex-col border-s border-border-main bg-bg-menu p-4 text-sm text-text-secondary">
        <p>{t('This file type has no workspace editor yet.')}</p>
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
          <p className="text-[11px] text-text-tertiary">{def.label}</p>
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
