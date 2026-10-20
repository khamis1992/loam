'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const sentDraftSessions = new Set<string>();
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
import { ComputerPanel } from '@/components/computer/ComputerPanel';
import { ShareDialog } from '@/components/dialogs/ShareDialog';
import { ChatSocket } from '@/services/chatSocket';
import { RpcClient, getApiBase, getSessionToken, handleAuthFailure } from '@/services/rpc';
import { uploadFile } from '@/services/upload';
import type {
  TaskMode,
  ChatEvent,
  ChatMessageEvent,
  StatusUpdateEvent,
  CascadeTaskClockEvent,
  ChatDeltaEvent,
  EventsNotifyEventsAfterEvent,
  ServerMessage,
  Attachment,
  ToolUsedEvent,
} from '@shared/socket';
import { formatDuration, formatTime } from '@/utils/format';

function getSocketBase(): string {
  if (typeof window === 'undefined') return '/';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.socketBase) return injected.socketBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return 'http://localhost:8787';
  return '/';
}

function computeClockDuration(clockEvent: CascadeTaskClockEvent): number {
  const { clock, timestamp } = clockEvent;
  const end = clock.phase === 'open' ? Date.now() : timestamp;
  if (clock.startedAt && end > clock.startedAt) return end - clock.startedAt;
  // Fall back to the backend accumulated value, guarding against values stored in seconds.
  const ms = clock.accumulatedMs ?? 0;
  return ms > 1_000_000_000 ? Math.floor(ms / 1000) : ms;
}

function parseAttachments(raw: string | null): Attachment[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ id?: string; url?: string; name?: string; filename?: string; contentType?: string }>;
    return list.map((a) => ({
      id: String(a.id ?? ''),
      filename: String(a.filename ?? a.name ?? 'attachment'),
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
  const socketRef = useRef<ChatSocket | null>(null);
  const sentDraft = useRef<{ uid: string; sent: boolean }>({ uid: '', sent: false });
  if (sentDraft.current.uid !== sessionUid) {
    sentDraft.current = { uid: sessionUid, sent: sentDraftSessions.has(sessionUid) };
  }
  const apiBase = useMemo(() => getApiBase(), []);
  const [shareOpen, setShareOpen] = useState(false);
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

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
      // Read the pending prompt once from the URL when this session first mounts.
      // We intentionally do not list searchParams/router as effect deps so a URL
      // cleanup after sending does not tear down the socket and replay history.
      const draft = searchParams.get('draft') || '';
      const isNewDraft = Boolean(draft);
      let existingSession: { title: string; lastDisplayMessage?: string; icon?: string } | undefined;
      if (!isNewDraft) {
        try {
          const res = await rpc.getSession({ sessionUid });
          existingSession = res.session;
        } catch (e) {
          // Only show an error for reloads of real sessions; new drafts may 404.
          onRpcError(e instanceof Error ? e.message : String(e));
        }
      }

      try {
        await socket.connect();
      } catch {
        if (!mounted) return;
        onAuthFailure();
        return;
      }
      if (!mounted) return;
      // Join before sending so the first message is received on this socket.
      socket.join(sessionUid);

      if (draft && !sentDraft.current.sent) {
        sentDraft.current.sent = true;
        sentDraftSessions.add(sessionUid);
        const mode = (searchParams.get('mode') as TaskMode) || 'standard';
        const cwd = searchParams.get('cwd') || undefined;
        const attachmentsParam = searchParams.get('attachments');
        const draftAttachments = attachmentsParam ? parseAttachments(attachmentsParam) : [];
        socket.sendText(sessionUid, draft, mode, draftAttachments, makeExtData(cwd));
        dispatch(addSession({
          uid: sessionUid,
          title: existingSession?.title ?? draft.slice(0, 60),
          status: 6,
          lastMessageTime: Date.now(),
          lastDisplayMessage: existingSession?.lastDisplayMessage ?? draft,
          icon: existingSession?.icon || '•',
        }));
        dispatch(selectSession(sessionUid));
        // Remove draft from the URL so a reload does not re-send it.
        const cleanParams = new URLSearchParams(searchParams.toString());
        cleanParams.delete('draft');
        const qs = cleanParams.toString();
        router.replace(`/app/${sessionUid}${qs ? `?${qs}` : ''}`, { scroll: false });
      } else if (existingSession?.title) {
        dispatch(addSession({
          uid: sessionUid,
          title: existingSession.title,
          status: 1,
          lastMessageTime: Date.now(),
          lastDisplayMessage: existingSession.lastDisplayMessage ?? '',
          icon: existingSession.icon || '•',
        }));
        dispatch(selectSession(sessionUid));
      }
    })();

    return () => {
      mounted = false;
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUid, apiBase, dispatch, onAuthFailure]);

  const clockEvent = useMemo(() =>
    [...events].reverse().find((e): e is CascadeTaskClockEvent => e.type === 'cascadeTaskClock'),
  [events]);

  const assistantText = useMemo(() => {
    const final = [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'assistant' && e.deliveryKind === 'result');
    return final?.content ?? '';
  }, [events]);

  const userText = useMemo(() => {
    const latest = [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'user');
    return latest?.content ?? '';
  }, [events]);

  const wasStoppedByUser = useMemo(() => events.some((e) => e.type === 'userStop'), [events]);

  const hasResult = useMemo(() => events.some((e) => e.type === 'chat' && e.sender === 'assistant' && e.deliveryKind === 'result'), [events]);
  const hasClockClosed = useMemo(() => events.some((e) => e.type === 'cascadeTaskClock' && e.clock.phase === 'closed'), [events]);
  const [selectedTool, setSelectedTool] = useState<ToolUsedEvent | null>(null);
  const autoOpenedRef = useRef<Set<string>>(new Set());

  // Auto-open Loam's computer panel on the first tool/computer activity event.
  useEffect(() => {
    if (selectedTool || autoOpenedRef.current.has(sessionUid)) return;
    const firstTool = events.find((e): e is ToolUsedEvent => e.type === 'toolUsed');
    if (firstTool) {
      setSelectedTool(firstTool);
      autoOpenedRef.current.add(sessionUid);
    }
  }, [events, sessionUid, selectedTool]);

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
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="flex h-row-sm items-center gap-1 rounded-control px-2 text-sm text-text-secondary hover:bg-fill-hover"
        >
          <Share className="size-4" /> {t('Share')}
        </button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><FileChartColumn className="size-4" /></button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><MoreHorizontal className="size-4" /></button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><PanelRight className="size-4" /></button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[768px] px-6 py-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-lg">◉</span>
                <span className="text-base font-semibold text-text-primary">{PRODUCT}</span>
              </div>
              {running && <div className="mb-2 text-sm text-text-tertiary">{t('{name} is thinking', { name: PRODUCT })}…</div>}
              {clockEvent && !running && (
                <div className="mb-2 text-sm text-text-tertiary">
                  {t('Worked for {duration}', { duration: formatDuration(computeClockDuration(clockEvent)) })} ›
                </div>
              )}
              {userText && !assistantText && !running && !wasStoppedByUser && !error && (
                <div className="mb-2 text-sm text-text-tertiary">
                  {t('{name} is thinking', { name: PRODUCT })}…
                </div>
              )}
              {error && !draftText && (
                <div className="mb-2 rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">
                  {error}
                </div>
              )}
              <EventList
                events={events}
                sessionId={sessionUid}
                socket={socketRef.current}
                onOpenComputer={(e) => setSelectedTool(e)}
              />

              {hasResult && hasClockClosed && !running && !wasStoppedByUser && (
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
              <span className={running ? 'animate-pulse text-icon-blue' : wasStoppedByUser ? 'text-function-warning' : hasResult && hasClockClosed ? 'text-func-success' : 'text-text-tertiary'}>
                {running ? '●' : wasStoppedByUser ? '◼' : hasResult && hasClockClosed ? '✓' : '○'}
              </span>
              {running ? t('Working') : wasStoppedByUser ? t('Stopped') : hasResult && hasClockClosed ? t('Task completed') : t('Thinking')}
            </div>
            <Composer onSend={handleSend} onStop={handleStop} running={running} />
          </div>
        </div>
        {selectedTool && <ComputerPanel sessionId={sessionUid} event={selectedTool} onClose={() => setSelectedTool(null)} />}
      </div>
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} url={shareUrl} />
    </div>
  );
}

function handleServerMessage(m: ServerMessage, sessionId: string, dispatch: AppDispatch) {
  if (m.type !== 'event') return;
  const ev = m.event;
  if (ev.type === 'eventsNotifyEventsAfter') {
    const notify = ev as unknown as EventsNotifyEventsAfterEvent;
    for (const rawInner of notify.events) {
      const inner = rawInner as ChatEvent;
      if (inner.type === 'chatDelta') {
        dispatch(applyDelta({ sessionId, delta: inner as ChatDeltaEvent }));
      } else {
        if (inner.type === 'statusUpdate') {
          dispatch(setStatus({ sessionId, status: (inner as StatusUpdateEvent).agentStatus }));
        }
        const errorLike = inner as unknown as { type?: string; message?: string };
        if (errorLike.type === 'error') {
          dispatch(setError({ sessionId, error: errorLike.message ?? t('An error occurred') }));
        }
        dispatch(appendEvent({ sessionId, event: inner }));
      }
    }
    return;
  }
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
