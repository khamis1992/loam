'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Info, Loader2, AlertCircle, ExternalLink, MoreHorizontal } from 'lucide-react';
import clsx from 'clsx';
import { useAppDispatch, useAppSelector, type AppDispatch } from '@/store';
import { appendEvent, applyDelta, setStatus, setError, replaceEvents } from '@/store/chatSlice';
import { addSession } from '@/store/sessionsSlice';
import { t } from '@/i18n/t';
import { ChatSocket, shortUid } from '@/services/chatSocket';
import { getApiBase, getApiHeaders, getSessionToken } from '@/services/rpc';
import { uploadFile } from '@/services/upload';
import type {
  TaskMode,
  ChatEvent,
  ChatMessageEvent,
  StatusUpdateEvent,
  ChatDeltaEvent,
  EventsNotifyEventsAfterEvent,
  ServerMessage,
  Attachment,
} from '@shared/socket';
import type { AgentCardAgent } from './AgentCard';
import { AgentAvatar } from './AgentAvatar';
import { GROKBOT_NOTE_HEADER } from '@/components/chat/GrokBotNote';
import { InstructionProposalCard, useInstructionProposals } from './InstructionHistory';
import { AgentThreadMessages } from './AgentThreadMessages';
import { AgentThreadComposer } from './AgentThreadComposer';

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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const socketRef = useRef<ChatSocket | null>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const apiBase = useMemo(() => getApiBase(), []);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!overflowRef.current?.contains(e.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [overflowOpen]);

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
      <header className="relative flex h-row shrink-0 items-center justify-end px-3">
        {/* Centered floating header pill: avatar + agent name opens the info pane. */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <button
            type="button"
            onClick={onToggleInfo}
            aria-expanded={infoOpen}
            aria-label={t('Agent info')}
            title={t('Agent info')}
            className="pointer-events-auto flex items-center gap-2 rounded-full border border-border-main bg-bg-menu px-2.5 py-1 shadow-card transition-colors hover:bg-fill-hover"
          >
            <AgentAvatar
              name={agent.name}
              avatarShape={agent.avatarShape}
              avatarColor={agent.avatarColor}
              avatarImage={agent.avatarImage}
              size={22}
              working={running}
              typing={running}
            />
            <span className="max-w-[40vw] truncate text-sm font-medium text-text-primary">{agent.name}</span>
            <ChevronDown
              className={clsx('size-3.5 shrink-0 text-text-tertiary transition-transform', infoOpen && 'rotate-180')}
            />
          </button>
        </div>

        {/* Compact overflow for the remaining header actions. */}
        <div className="relative flex items-center" ref={overflowRef}>
          <button
            type="button"
            onClick={() => setOverflowOpen((v) => !v)}
            aria-label={t('More')}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            title={t('More')}
            className="flex size-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-fill-hover hover:text-text-primary"
          >
            <MoreHorizontal className="size-4" />
          </button>
          {overflowOpen && (
            <div
              role="menu"
              className="absolute end-0 top-full z-50 mt-1 min-w-[180px] rounded-card border border-border-main bg-bg-menu p-1 shadow-menu"
            >
              {threadUid && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    handleOpenTaskView();
                  }}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm text-text-primary hover:bg-fill-hover"
                >
                  <ExternalLink className="size-4 shrink-0 text-text-tertiary" />
                  {t('Open in task view')}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOverflowOpen(false);
                  onToggleInfo();
                }}
                className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm text-text-primary hover:bg-fill-hover"
              >
                <Info className="size-4 shrink-0 text-text-tertiary" />
                {t('Toggle info pane')}
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[768px]">
              {!resolving && proposals.length > 0 && (
                <div className="flex flex-col gap-2 px-4 pt-4">
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
                <AgentThreadMessages
                  events={events}
                  sessionId={threadUid ?? ''}
                  socket={socketRef.current}
                  running={running}
                  onOpenComputer={() => {}}
                />
              )}
              {!resolving && !error && events.length > 0 && hasResult && hasClockClosed && !running && !wasStoppedByUser && (
                <p className="px-4 pt-1 pb-2 text-center text-sm text-func-success">{t('Task completed')}</p>
              )}
            </div>
          </div>

          <div className="mx-auto w-full max-w-[768px] px-4 pt-2 pb-4">
            <AgentThreadComposer
              onSend={handleSend}
              onStop={handleStop}
              running={running || sending}
              placeholder={t('Message {name}', { name: agent.name })}
              assistantReply={assistantText}
              approveForMe={approveForMe}
              onToggleApproveForMe={handleToggleApproveForMe}
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
