'use client';

import { useEffect, useMemo, useRef } from 'react';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import {
  Share, FileChartColumn, MoreHorizontal, PanelRight, CircleCheck, Copy, Repeat2,
  Star,
} from 'lucide-react';
import { useAppDispatch, useAppSelector, type AppDispatch } from '@/store';
import { appendEvent, applyDelta, setStatus, setError } from '@/store/chatSlice';
import { addSession, selectSession } from '@/store/sessionsSlice';
import { t, PRODUCT } from '@/i18n/t';
import { Composer } from '@/components/chat/Composer';
import { EventList } from '@/components/chat/EventList';
import { ChatSocket } from '@/services/chatSocket';
import { RpcClient, getApiBase, getSessionToken, handleAuthFailure } from '@/services/rpc';
import { uploadFile } from '@/services/upload';
import type {
  TaskMode,
  ChatMessageEvent,
  StatusUpdateEvent,
  CascadeTaskClockEvent,
  ChatDeltaEvent,
  ServerMessage,
  Attachment,
} from '@shared/socket';
import { formatDuration, formatTime } from '@/utils/format';

function getSocketBase(): string {
  if (typeof window === 'undefined') return '/';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.socketBase) return injected.socketBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return 'http://localhost:8787';
  return '/';
}

function parseAttachments(raw: string | null): Attachment[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ id?: string; url?: string; name?: string; contentType?: string }>;
    return list.map((a) => ({
      id: String(a.id ?? ''),
      filename: String(a.name ?? 'attachment'),
      type: 'file' as const,
      url: String(a.url ?? ''),
      contentType: String(a.contentType ?? 'application/octet-stream'),
      fileMetaData: { tag: 'upload' as const, uploadStatus: 'success' as const, uploadProgress: 100 },
    }));
  } catch {
    return [];
  }
}

function makeExtData(cwd?: string): Record<string, unknown> | undefined {
  if (!cwd) return undefined;
  return {
    desktopBinding: {
      deviceId: 'desktop',
      folderPath: cwd,
    },
  };
}

export default function TaskPageClient(_props: { params: Promise<{ sessionUid: string }> }) {
  const pathname = usePathname();
  const router = useRouter();
  const sessionUid = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'demo-running';
  }, [pathname]);

  const searchParams = useSearchParams();
  const dispatch = useAppDispatch();
  const events = useAppSelector((s) => s.chat.eventsBySession[sessionUid] ?? []);
  const status = useAppSelector((s) => s.chat.statusBySession[sessionUid]);
  const running = useAppSelector((s) => s.chat.running[sessionUid] ?? false);
  const error = useAppSelector((s) => s.chat.errorsBySession[sessionUid]);
  const draftText = searchParams.get('draft') || '';
  const draftMode = (searchParams.get('mode') as TaskMode) || 'standard';
  const cwd = searchParams.get('cwd') || undefined;
  const attachmentsParam = searchParams.get('attachments');
  const draftAttachments = useMemo(() => parseAttachments(attachmentsParam), [attachmentsParam]);
  const sentDraft = useRef(false);

  const socketRef = useRef<ChatSocket | null>(null);
  const apiBase = useMemo(() => getApiBase(), []);

  const onAuthFailure = useMemo(() => () => {
    dispatch(setError({ sessionId: sessionUid, error: t('Session expired. Please sign in again.') }));
    handleAuthFailure();
  }, [dispatch, sessionUid]);

  const onRpcError = (message: string) => {
    dispatch(setError({ sessionId: sessionUid, error: message }));
  };

  useEffect(() => {
    const rpc = new RpcClient({
      getToken: getSessionToken,
      apiBase,
      onUnauthorized: onAuthFailure,
    });
    const socket = new ChatSocket({
      getToken: getSessionToken,
      socketBase: getSocketBase(),
      onMessage: (m: ServerMessage) => handleServerMessage(m, sessionUid, dispatch),
      onAuthFailure,
      onError: onRpcError,
    });
    socketRef.current = socket;
    let mounted = true;

    (async () => {
      await socket.connect();
      if (!mounted) return;
      socket.join(sessionUid);
      if (draftText && !sentDraft.current) {
        sentDraft.current = true;
        socket.sendText(sessionUid, draftText, draftMode, draftAttachments, makeExtData(cwd));
        dispatch(addSession({
          uid: sessionUid,
          title: draftText.slice(0, 60),
          status: 6,
          lastMessageTime: Date.now(),
          lastDisplayMessage: draftText,
          icon: '•',
        }));
        dispatch(selectSession(sessionUid));
        // Remove draft from the URL so a reload does not re-send it.
        const cleanParams = new URLSearchParams(searchParams.toString());
        cleanParams.delete('draft');
        const qs = cleanParams.toString();
        router.replace(`/app/${sessionUid}${qs ? `?${qs}` : ''}`);
      }

      // Hydrate existing session metadata (title etc.) from RPC if available.
      if (!draftText) {
        try {
          const res = await rpc.getSession({ sessionUid });
          if (res?.session?.title) {
            dispatch(addSession({
              uid: sessionUid,
              title: res.session.title,
              status: 1,
              lastMessageTime: Date.now(),
              lastDisplayMessage: res.session.lastDisplayMessage ?? '',
              icon: res.session.icon || '•',
            }));
            dispatch(selectSession(sessionUid));
          }
        } catch (e) {
          onRpcError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      mounted = false;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionUid, draftText, draftMode, draftAttachments, cwd, apiBase, dispatch, onAuthFailure, searchParams, router]);

  const clockEvent = useMemo(() =>
    [...events].reverse().find((e): e is CascadeTaskClockEvent => e.type === 'cascadeTaskClock'),
  [events]);

  const assistantText = useMemo(() => {
    const final = [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'assistant' && e.deliveryKind === 'result');
    return final?.content ?? '';
  }, [events]);

  const wasStoppedByUser = useMemo(() => events.some((e) => e.type === 'userStop'), [events]);

  const handleSend = async (text: string, mode: TaskMode, files: File[]) => {
    const socket = socketRef.current;
    if (!socket) return;
    dispatch(setStatus({ sessionId: sessionUid, status: 'running' }));
    let attachments = draftAttachments;
    if (files.length > 0) {
      const uploaded = await Promise.all(files.map((f) => uploadFile(apiBase, f)));
      attachments = [...attachments, ...uploaded];
    }
    socket.sendText(sessionUid, text, mode, attachments, makeExtData(cwd));
  };

  const handleStop = () => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.stop(sessionUid);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-row items-center justify-end gap-2 px-6">
        <button className="flex h-row-sm items-center gap-1 rounded-control px-2 text-sm text-text-secondary hover:bg-fill-hover">
          <Share className="size-4" /> {t('Share')}
        </button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><FileChartColumn className="size-4" /></button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><MoreHorizontal className="size-4" /></button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><PanelRight className="size-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[768px] px-6 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-lg">◉</span>
            <span className="text-base font-semibold text-text-primary">{PRODUCT}</span>
          </div>
          {running && <div className="mb-2 text-sm text-text-tertiary">{t('{name} is thinking', { name: PRODUCT })}…</div>}
          {clockEvent && !running && (
            <div className="mb-2 text-sm text-text-tertiary">
              {t('Worked for {duration}', { duration: formatDuration(clockEvent.clock.accumulatedMs) })} ›
            </div>
          )}
          {error && (
            <div className="mb-2 rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">
              {error}
            </div>
          )}
          <EventList events={events} sessionId={sessionUid} socket={socketRef.current} />

          {assistantText && !running && (
            <div className="mx-auto w-full max-w-[768px] px-[var(--ui-content-padding-x,24px)]">
              <div className="mb-2 flex items-center gap-2 text-sm text-func-success">
                <CircleCheck className="size-4" /> {t('Task completed')}
              </div>
              <div className="mb-4 flex items-center gap-2 text-sm text-text-tertiary">
                <button className="rounded-control p-1 hover:bg-fill-hover"><Copy className="size-4" /></button>
                <button className="rounded-control p-1 hover:bg-fill-hover"><Repeat2 className="size-4" /></button>
                <span className="ms-auto">{formatTime(Date.now())}</span>
              </div>
              <div className="mb-2 flex items-center gap-2 text-sm text-text-secondary">
                <span className="ms-auto">{t('How was this result?')}</span>
                {[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-4 text-[#d4d4d4]" />)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[768px] px-6 pb-4">
        <div className="mb-2 flex h-row-sm items-center gap-2 rounded-control bg-fill-tsp px-2 text-sm text-text-secondary">
          <span className={running ? 'animate-pulse text-icon-blue' : wasStoppedByUser ? 'text-function-warning' : 'text-func-success'}>
            {running ? '●' : wasStoppedByUser ? '◼' : '✓'}
          </span>
          {running ? t('Working') : wasStoppedByUser ? t('Stopped') : t('Task completed')}
        </div>
        <Composer onSend={handleSend} onStop={handleStop} running={running} />
      </div>
    </div>
  );
}

function handleServerMessage(m: ServerMessage, sessionId: string, dispatch: AppDispatch) {
  if (m.type !== 'event') return;
  const ev = m.event;
  if (ev.type === 'chatDelta') {
    dispatch(applyDelta({ sessionId, delta: ev as ChatDeltaEvent }));
    return;
  }
  if (ev.type === 'statusUpdate') {
    dispatch(setStatus({ sessionId, status: (ev as StatusUpdateEvent).agentStatus }));
  }
  const errorLike = ev as unknown as { type?: string; message?: string };
  if (errorLike.type === 'error') {
    dispatch(setError({ sessionId, error: errorLike.message ?? t('An error occurred') }));
  }
  dispatch(appendEvent({ sessionId, event: ev }));
}
