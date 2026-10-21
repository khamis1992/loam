'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Info, PanelRight, Loader2, AlertCircle, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { useAppDispatch, useAppSelector, type AppDispatch } from '@/store';
import { appendEvent, applyDelta, setStatus, setError, replaceEvents } from '@/store/chatSlice';
import { addSession } from '@/store/sessionsSlice';
import { t, PRODUCT } from '@/i18n/t';
import { Composer } from '@/components/chat/Composer';
import { EventList } from '@/components/chat/EventList';
import { ChatSocket, shortUid } from '@/services/chatSocket';
import { getApiBase, getApiHeaders, getSessionToken } from '@/services/rpc';
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
} from '@shared/socket';
import type { AgentCardAgent } from './AgentCard';
import { GROKBOT_NOTE_HEADER } from '@/components/chat/GrokBotNote';
import { InstructionProposalCard, useInstructionProposals } from './InstructionHistory';

function getSocketBase(): string {
  if (typeof window === 'undefined') return '/';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.socketBase) return injected.socketBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return 'http://localhost:8787';
  return '/';
}

export const AGENT_THREAD_KEY = 'loam.agentThread';

interface TaskMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
}

interface TaskFileEntry {
  name: string;
  path: string;
  bytes: number;
  dir: boolean;
}

export interface AgentThreadViewProps {
  agent: AgentCardAgent;
  onToggleInfo: () => void;
  infoOpen: boolean;
  onTaskCreated?: (uid: string) => void;
}

export async function persistAgentThread(agentId: string, threadUid: string): Promise<void> {
  try {
    await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/thread`, {
      method: 'PUT',
      headers: await getApiHeaders(),
      body: JSON.stringify({ threadUid }),
    });
  } catch {}
}

export async function resolveAgentThread(agentId: string): Promise<string | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/thread`, {
      headers: await getApiHeaders(),
    });
    if (res.ok) {
      const data = (await res.json()) as { item?: { threadUid?: string } };
      if (data.item?.threadUid) return data.item.threadUid;
    }
  } catch {}
  const stored = typeof window !== 'undefined' ? localStorage.getItem(`${AGENT_THREAD_KEY}.${agentId}`) : null;
  if (stored) {
    void persistAgentThread(agentId, stored);
    localStorage.removeItem(`${AGENT_THREAD_KEY}.${agentId}`);
    return stored;
  }
  try {
    const res = await fetch(`${getApiBase()}/api/tasks?agentId=${encodeURIComponent(agentId)}`, {
      headers: await getApiHeaders(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tasks?: Array<{ id: string; createdAt: string }> };
    const tasks = (data.tasks ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return tasks[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function loadAgentThreadMessages(uid: string): Promise<ChatEvent[]> {
  try {
    const res = await fetch(`${getApiBase()}/api/tasks/${encodeURIComponent(uid)}`, {
      headers: await getApiHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { task?: { messages?: TaskMessage[] } };
    const messages = data.task?.messages ?? [];
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => {
        const ts = Date.parse(m.at) || Date.now();
        const id = `history-${uid}-${i}`;
        return {
          id,
          type: 'chat',
          timestamp: ts,
          sender: m.role,
          messageType: 'text',
          content: m.content,
          attachments: [],
          deliveryKind: 'result',
        } as ChatMessageEvent;
      });
  } catch {
    return [];
  }
}

export async function loadAgentThreadFiles(uid: string): Promise<TaskFileEntry[]> {
  try {
    const res = await fetch(`${getApiBase()}/api/tasks/${encodeURIComponent(uid)}/files?path=`, {
      headers: await getApiHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { files?: TaskFileEntry[] };
    return (data.files ?? []).filter((f) => !f.dir);
  } catch {
    return [];
  }
}

interface MirroredNote {
  id: string;
  text: string;
  ts: string;
  /** True when the server already appended this note into the agent thread. */
  threadAppended?: boolean;
}

/** READ-ONLY notes mirrored from Grok Bot for this agent (bridge store). */
export async function loadMirroredNotes(agentId: string): Promise<MirroredNote[]> {
  try {
    const res = await fetch(`${getApiBase()}/api/bridge/grokbot/mirror?agentRef=${encodeURIComponent(agentId)}`, {
      headers: await getApiHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { messages?: MirroredNote[] };
    return data.messages ?? [];
  } catch {
    return [];
  }
}

/** Best-effort dedupe: notes already appended to the thread history reuse the same text. */
export function labelledNoteContent(text: string): string {
  return `${GROKBOT_NOTE_HEADER}\n${text}`;
}

export function AgentThreadView({ agent, onToggleInfo, infoOpen, onTaskCreated }: AgentThreadViewProps) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [threadUid, setThreadUid] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [error, setLocalError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [approveForMe, setApproveForMe] = useState(false);
  const socketRef = useRef<ChatSocket | null>(null);
  const apiBase = useMemo(() => getApiBase(), []);
  const composerRef = useRef<React.ElementRef<typeof Composer>>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const events = useAppSelector((s) => (threadUid ? s.chat.eventsBySession[threadUid] ?? [] : []));
  const running = useAppSelector((s) => (threadUid ? s.chat.running[threadUid] ?? false : false));
  const status = useAppSelector((s) => (threadUid ? s.chat.statusBySession[threadUid] : undefined));

  const { proposals, refresh: refreshProposals } = useInstructionProposals(agent.id);

  const onAuthFailure = useMemo(
    () => () => {
      if (threadUid) dispatch(setError({ sessionId: threadUid, error: t('Session expired. Please sign in again.') }));
    },
    [dispatch, threadUid],
  );

  const onRpcError = (message: string) => {
    if (threadUid) dispatch(setError({ sessionId: threadUid, error: message }));
    setLocalError(message);
  };

  // Resolve thread uid when agent changes and persist discovered/created uids.
  useEffect(() => {
    let mounted = true;
    setResolving(true);
    setLocalError(null);
    // MF4: restore the "Approve for me" chip state per agent.
    try {
      if (typeof window !== 'undefined') setApproveForMe(localStorage.getItem(`loam.approveForMe.${agent.id}`) === '1');
    } catch {}
    resolveAgentThread(agent.id).then((uid) => {
      if (!mounted) return;
      setThreadUid(uid);
      if (uid) void persistAgentThread(agent.id, uid);
      setResolving(false);
    });
    return () => { mounted = false; };
  }, [agent.id]);

  // Connect socket and load history when thread uid is known.
  useEffect(() => {
    if (!threadUid) return;
    let mounted = true;
    setLocalError(null);

    const socket = new ChatSocket({
      getToken: getSessionToken,
      socketBase: getSocketBase(),
      onMessage: (m: ServerMessage) => handleServerMessage(m, threadUid, dispatch),
      onAuthFailure,
      onError: onRpcError,
    });
    socketRef.current = socket;

    (async () => {
      const history = await loadAgentThreadMessages(threadUid);
      if (!mounted) return;
      if (history.length > 0) {
        dispatch(replaceEvents({ sessionId: threadUid, events: history }));
      }
      void syncMirroredNotes(threadUid);
      try {
        await socket.connect();
      } catch {
        if (!mounted) return;
        onAuthFailure();
        return;
      }
      if (!mounted) return;
      socket.join(threadUid);
    })();

    const poll = setInterval(() => void syncMirroredNotes(threadUid), 20_000);

    return () => {
      mounted = false;
      clearInterval(poll);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [threadUid, dispatch, onAuthFailure]);

  const clockEvent = useMemo(
    () => [...events].reverse().find((e): e is CascadeTaskClockEvent => e.type === 'cascadeTaskClock'),
    [events],
  );

  const userText = useMemo(
    () => [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'user')?.content ?? '',
    [events],
  );

  const assistantText = useMemo(
    () =>
      [...events]
        .reverse()
        .find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'assistant' && e.deliveryKind === 'result')
        ?.content ?? '',
    [events],
  );

  const wasStoppedByUser = useMemo(() => events.some((e) => e.type === 'userStop'), [events]);
  const hasResult = useMemo(
    () => events.some((e) => e.type === 'chat' && e.sender === 'assistant' && e.deliveryKind === 'result'),
    [events],
  );
  const hasClockClosed = useMemo(
    () => events.some((e) => e.type === 'cascadeTaskClock' && e.clock.phase === 'closed'),
    [events],
  );

  const handleSend = async (text: string, mode: TaskMode, files: File[], extData?: Record<string, unknown>) => {
    let uid = threadUid;
    let socket = socketRef.current;

    if (!uid) {
      uid = shortUid();
      setThreadUid(uid);
      void persistAgentThread(agent.id, uid);
      onTaskCreated?.(uid);
    }

    if (!socket) {
      socket = new ChatSocket({
        getToken: getSessionToken,
        socketBase: getSocketBase(),
        onMessage: (m: ServerMessage) => handleServerMessage(m, uid, dispatch),
        onAuthFailure,
        onError: onRpcError,
      });
      socketRef.current = socket;
      try {
        await socket.connect();
      } catch (e) {
        setLocalError(e instanceof Error ? e.message : String(e));
        return;
      }
      socket.join(uid);
    }

    setSending(true);
    dispatch(setStatus({ sessionId: uid, status: 'running' }));

    let attachments: Attachment[] = [];
    if (files.length > 0) {
      attachments = await Promise.all(files.map((f) => uploadFile(apiBase, f)));
    }

    const extra: Record<string, unknown> = {
      agentId: agent.id,
      approveForMe,
      ...(agent.mode ? { loamMode: agent.mode } : {}),
      ...(agent.workMode ? { workMode: agent.workMode } : {}),
      ...extData,
    };

    socket.sendText(uid, text, mode, attachments, Object.keys(extra).length > 0 ? extra : undefined);

    dispatch(
      addSession({
        uid,
        title: text.slice(0, 60),
        status: 6,
        lastMessageTime: Date.now(),
        lastDisplayMessage: text,
        icon: agent.emoji || '•',
      }),
    );

    setTimeout(() => setSending(false), 150);
  };

  const handleStop = () => {
    if (threadUid) socketRef.current?.stop(threadUid);
  };

  // MF4: "Approve for me" chip — toggles auto-approve for the current task.
  // The flag rides on the next message (extData) and is pushed live for threads
  // that already map to a Loam task id.
  const handleToggleApproveForMe = () => {
    const next = !approveForMe;
    setApproveForMe(next);
    try {
      localStorage.setItem(`loam.approveForMe.${agent.id}`, next ? '1' : '0');
    } catch {}
    if (threadUid) {
      void (async () => {
        try {
          await fetch(`${getApiBase()}/api/approval-tasks/${encodeURIComponent(threadUid)}`, {
            method: 'PUT',
            headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
            body: JSON.stringify({ auto: next }),
          });
        } catch {
          // Best effort: runs without a resolved task id still pick it up via extData.
        }
      })();
    }
  };

  const handleOpenTaskView = () => {
    if (threadUid) router.push(`/app/${threadUid}`);
  };

  // Mirrored "from Grok Bot" notes (READ-ONLY): ingest calls that happened when
  // the agent had no chat thread yet never landed in history, so they are
  // merged here from the bridge store. Notes already appended server-side
  // (threadAppended) render through the normal history and are skipped.
  const syncedMirrorIds = useRef<Set<string>>(new Set());
  const syncMirroredNotes = useCallback(async (sessionId: string) => {
    if (!agent.id) return;
    const notes = await loadMirroredNotes(agent.id);
    if (!mountedRef.current) return;
    for (const note of notes) {
      if (note.threadAppended === true || syncedMirrorIds.current.has(note.id)) continue;
      syncedMirrorIds.current.add(note.id);
      dispatch(
        appendEvent({
          sessionId,
          event: {
            id: `gb-${note.id}`,
            type: 'chat',
            timestamp: Date.parse(note.ts) || Date.now(),
            sender: 'user',
            senderId: 'grokbot',
            messageType: 'text',
            content: `${GROKBOT_NOTE_HEADER}\n${note.text}`,
            attachments: [],
            deliveryKind: 'result',
          },
        }),
      );
    }
  }, [agent.id, dispatch]);

  return (
    <div className={clsx('flex flex-1 flex-col overflow-hidden bg-bg-main', infoOpen && 'min-w-[360px]')}>
      <header className="flex h-row shrink-0 items-center justify-between border-b border-border-main px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onToggleInfo}
            className="flex min-w-0 items-center gap-2 rounded-control px-2 py-1 text-start hover:bg-fill-hover"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-fill-tsp text-base">
              {agent.emoji || '🤖'}
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-text-primary">{agent.name}</span>
            <PanelRight className={`size-3.5 shrink-0 text-text-tertiary transition-transform ${infoOpen ? 'rotate-180' : ''}`} />
          </button>
          <span className="hidden text-xs text-text-tertiary sm:inline">
            {agent.mode || 'loam'} · {agent.model || PRODUCT}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {threadUid && (
            <button
              type="button"
              onClick={handleOpenTaskView}
              className="flex h-row-sm items-center gap-1 rounded-control px-2 text-xs text-text-secondary hover:bg-fill-hover"
            >
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">{t('Open in task view')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onToggleInfo}
            className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
            aria-label={t('Toggle info pane')}
            title={t('Toggle info pane')}
          >
            <Info className="size-4" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[768px] px-4 py-4">
              {!resolving && proposals.length > 0 && (
                <div className="mb-4 flex flex-col gap-2">
                  {proposals.map((p) => (
                    <InstructionProposalCard
                      key={p.id}
                      proposal={p}
                      agentName={agent.name}
                      onDone={refreshProposals}
                    />
                  ))}
                </div>
              )}
              {resolving ? (
                <div className="flex h-full items-center justify-center text-text-secondary">
                  <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-function-error">
                  <AlertCircle className="size-6" />
                  <p className="text-sm">{error}</p>
                </div>
              ) : events.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
                  <p className="text-sm">{t('No messages yet.')}</p>
                  <p className="max-w-[320px] text-center text-xs">
                    {t('Send a message to start a permanent thread with this agent.')}
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex items-center gap-2">
                    <span className="text-lg">{agent.emoji || '🤖'}</span>
                    <span className="text-base font-semibold text-text-primary">{agent.name}</span>
                  </div>
                  {running && <div className="mb-2 text-sm text-text-tertiary">{t('{name} is thinking', { name: PRODUCT })}…</div>}
                  {clockEvent && !running && (
                    <div className="mb-2 text-sm text-text-tertiary">
                      {t('Active')} · {new Date(clockEvent.clock.startedAt).toLocaleString()}
                    </div>
                  )}
                  {userText && !assistantText && !running && !wasStoppedByUser && !error && (
                    <div className="mb-2 text-sm text-text-tertiary">{t('{name} is thinking', { name: PRODUCT })}…</div>
                  )}
                  <EventList
                    events={events}
                    sessionId={threadUid ?? ''}
                    socket={socketRef.current}
                    onOpenComputer={() => {}}
                  />
                  {hasResult && hasClockClosed && !running && !wasStoppedByUser && (
                    <div className="mt-2 text-sm text-func-success">{t('Task completed')}</div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="mx-auto w-full max-w-[768px] px-4 pb-4">
            <div className="mb-2 flex h-row-sm items-center gap-2 rounded-control bg-fill-tsp px-2 text-sm text-text-secondary">
              <span
                className={
                  running
                    ? 'animate-pulse text-icon-blue'
                    : wasStoppedByUser
                      ? 'text-function-warning'
                      : hasResult && hasClockClosed
                        ? 'text-func-success'
                        : 'text-text-tertiary'
                }
              >
                {running ? '●' : wasStoppedByUser ? '◼' : hasResult && hasClockClosed ? '✓' : '○'}
              </span>
              {running ? t('Working') : wasStoppedByUser ? t('Stopped') : hasResult && hasClockClosed ? t('Task completed') : t('Thinking')}
            </div>
            <Composer
              ref={composerRef}
              onSend={handleSend}
              onStop={handleStop}
              running={running || sending}
              defaultLoamMode={agent.mode}
              approveForMe={approveForMe}
              onToggleApproveForMe={handleToggleApproveForMe}
              assistantReply={assistantText}
              placeholder={t('Message {name}', { name: agent.name })}
            />
          </div>
        </div>

      </div>
    </div>
  );
}

function ComputerPlaceholder({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full flex-col border-s border-border-main bg-bg-menu">
      <div className="flex h-[40px] items-center justify-between border-b border-border-main px-2">
        <span className="text-sm font-semibold text-text-primary">{t("Loam's computer")}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('Close')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-text-tertiary">{t('No computer activity selected')}</p>
      </div>
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
