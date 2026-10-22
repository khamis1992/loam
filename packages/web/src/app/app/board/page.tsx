'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Kanban,
  Loader2,
  Plus,
  Send,
  X,
} from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { AgentAvatar } from '@/components/agents/AgentAvatar';

type TicketStatus = 'todo' | 'doing' | 'review' | 'done';
type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

interface Ticket {
  id: string;
  title: string;
  body: string;
  status: TicketStatus;
  assigneeAgentId: string | null;
  createdBy: string;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
}

interface TicketComment {
  id: string;
  ticketId: string;
  author: string;
  text: string;
  createdAt: string;
}

interface AgentMeta {
  id: string;
  name: string;
  emoji?: string;
}

const COLUMNS: Array<{ status: TicketStatus; label: string }> = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
];

const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

const priorityChip: Record<TicketPriority, string> = {
  low: 'bg-fill-tsp text-text-tertiary',
  normal: 'bg-fill-tsp text-text-secondary',
  high: 'bg-function-warning-tsp text-function-warning',
  urgent: 'bg-function-error-tsp text-function-error',
};

function BoardPageFallback() {
  return (
    <div className="flex h-full items-center justify-center text-text-secondary">
      <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
    </div>
  );
}

function BoardPageClient() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TicketStatus | null>(null);

  const agentById = useMemo(() => {
    const map: Record<string, AgentMeta> = {};
    for (const a of agents) map[a.id] = a;
    return map;
  }, [agents]);

  const refresh = useCallback(async () => {
    const res = await fetch(`${getApiBase()}/api/board/tickets`, { headers: await getApiHeaders() });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { tickets?: Ticket[] };
    return data.tickets ?? [];
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [nextTickets, agentRes] = await Promise.all([
          refresh(),
          fetch(`${getApiBase()}/api/agents`, { headers: await getApiHeaders() }),
        ]);
        if (!mounted) return;
        setTickets(nextTickets);
        if (agentRes.ok) {
          const data = (await agentRes.json()) as { agents?: AgentMeta[]; results?: AgentMeta[] };
          setAgents(data.agents ?? data.results ?? []);
        }
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [refresh]);

  const moveTicket = useCallback(
    async (id: string, status: TicketStatus) => {
      setTickets((prev) => prev.map((tk) => (tk.id === id ? { ...tk, status } : tk)));
      try {
        const res = await fetch(`${getApiBase()}/api/board/tickets/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: await getApiHeaders(),
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { ticket?: Ticket };
        if (data.ticket) setTickets((prev) => prev.map((tk) => (tk.id === id ? data.ticket! : tk)));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        refresh()
          .then((next) => setTickets(next))
          .catch(() => {});
      }
    },
    [refresh],
  );

  const detail = detailId ? tickets.find((tk) => tk.id === detailId) ?? null : null;
  void detail;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
          }}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="flex flex-1 items-center gap-2 text-title-lg text-text-primary">
          <Kanban className="size-5" /> {t('Board')}
        </h1>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="flex h-row-sm items-center gap-1.5 rounded-control bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover"
        >
          <Plus className="size-4" /> {t('New ticket')}
        </button>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        {loading ? (
          <BoardPageFallback />
        ) : error && tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-function-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load board')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : (
          <div className="flex h-full min-w-0 gap-3">
            {COLUMNS.map(({ status, label }) => {
              const column = tickets.filter((tk) => tk.status === status);
              return (
                <div
                  key={status}
                  onDragOver={(e) => {
                    if (dragId) {
                      e.preventDefault();
                      setDragOver(status);
                    }
                  }}
                  onDragLeave={() => setDragOver((prev) => (prev === status ? null : prev))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId) void moveTicket(dragId, status);
                    setDragId(null);
                    setDragOver(null);
                  }}
                  className={`flex h-full w-[240px] shrink-0 flex-col rounded-card border border-border-main bg-bg-menu ${
                    dragOver === status ? 'bg-fill-tsp' : ''
                  }`}
                  data-status={status}
                >
                  <div className="flex h-row shrink-0 items-center justify-between border-b border-border-main px-2.5">
                    <span className="text-xs font-medium text-text-secondary">{t(label)}</span>
                    <span className="rounded-full bg-fill-tsp px-1.5 text-[10px] text-text-tertiary">{column.length}</span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                    {column.map((ticket) => (
                      <TicketCard
                        key={ticket.id}
                        ticket={ticket}
                        assignee={ticket.assigneeAgentId ? agentById[ticket.assigneeAgentId] : undefined}
                        draggable
                        dragging={dragId === ticket.id}
                        onDragStart={() => setDragId(ticket.id)}
                        onDragEnd={() => {
                          setDragId(null);
                          setDragOver(null);
                        }}
                        onOpen={() => setDetailId(ticket.id)}
                        onMove={(next) => void moveTicket(ticket.id, next)}
                      />
                    ))}
                    {column.length === 0 && (
                      <p className="px-1 py-4 text-center text-[11px] text-text-tertiary">{t('No tickets here.')}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {newOpen && (
        <NewTicketDialog
          onClose={() => setNewOpen(false)}
          onCreated={(ticket) => {
            setTickets((prev) => [...prev, ticket]);
            setNewOpen(false);
          }}
        />
      )}
      {detailId && detail && (
        <TicketDrawer
          ticket={detail}
          agentById={agentById}
          onApply={(ticket) => setTickets((prev) => prev.map((tk) => (tk.id === ticket.id ? ticket : tk)))}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

function TicketCard({
  ticket,
  assignee,
  dragging,
  draggable,
  onDragStart,
  onDragEnd,
  onOpen,
  onMove,
}: {
  ticket: Ticket;
  assignee?: AgentMeta;
  dragging: boolean;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onMove: (status: TicketStatus) => void;
}) {
  const index = COLUMNS.findIndex((c) => c.status === ticket.status);
  const prev = index > 0 ? COLUMNS[index - 1]!.status : null;
  const next = index < COLUMNS.length - 1 ? COLUMNS[index + 1]!.status : null;
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`cursor-pointer rounded-control border border-border-main bg-bg-main p-2 hover:bg-fill-hover ${
        dragging ? 'opacity-50' : ''
      }`}
    >
      <p className="line-clamp-2 text-xs font-medium text-text-primary">{ticket.title}</p>
      {ticket.body && <p className="mt-1 line-clamp-2 text-[11px] text-text-tertiary">{ticket.body}</p>}
      <div className="mt-2 flex items-center justify-between gap-1">
        <div className="flex min-w-0 items-center gap-1">
          {ticket.priority !== 'normal' && (
            <span className={`rounded-full px-1.5 py-0 text-[10px] font-medium ${priorityChip[ticket.priority]}`}>
              {t(ticket.priority)}
            </span>
          )}
          <span className="min-w-0 truncate text-[10px] text-text-tertiary">
            {assignee ? assignee.name : t('Unassigned')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {assignee && (
            <span title={assignee.name} className="flex shrink-0">
              <AgentAvatar name={assignee.name} id={assignee.id} emoji={assignee.emoji} size={16} />
            </span>
          )}
          {prev && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMove(prev);
              }}
              aria-label={t('Move back')}
              title={t('Move back')}
              className="rounded p-0.5 text-text-tertiary hover:bg-fill-tsp hover:text-text-primary"
            >
              <ChevronLeft className="size-3.5" />
            </button>
          )}
          {next && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMove(next);
              }}
              aria-label={t('Move forward')}
              title={t('Move forward')}
              className="rounded p-0.5 text-text-tertiary hover:bg-fill-tsp hover:text-text-primary"
            >
              <ChevronRight className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NewTicketDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (ticket: Ticket) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/board/tickets`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ title, body, priority }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { ticket?: Ticket };
      if (data.ticket) onCreated(data.ticket);
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-card border border-border-main bg-bg-menu p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-primary">{t('New ticket')}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-text-tertiary hover:bg-fill-hover">
            <X className="size-4" />
          </button>
        </div>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('Ticket title')}
          className="mb-2 w-full rounded-control border border-border-main bg-bg-main px-2.5 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('Details')}
          rows={4}
          className="mb-2 w-full resize-none rounded-control border border-border-main bg-bg-main px-2.5 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        />
        <div className="mb-3 flex items-center gap-1">
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}
            className="rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-xs text-text-primary outline-none"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(p)}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="mb-2 text-xs text-function-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-control px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover">
            {t('Cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !title.trim()}
            onClick={() => void submit()}
            className="flex items-center gap-1.5 rounded-control bg-fill-hover px-3 py-1.5 text-sm text-text-primary disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />} {t('Create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TicketDrawer({
  ticket,
  agentById,
  onApply,
  onClose,
}: {
  ticket: Ticket;
  agentById: Record<string, AgentMeta>;
  onApply: (ticket: Ticket) => void;
  onClose: () => void;
}) {
  const [openTicket, setOpenTicket] = useState<Ticket>(ticket);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/board/tickets/${encodeURIComponent(ticket.id)}`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { ticket?: Ticket; comments?: TicketComment[] };
        if (!mounted) return;
        if (data.ticket) setOpenTicket(data.ticket);
        setComments(data.comments ?? []);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setCommentsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [ticket.id]);

  const act = async (fn: () => Promise<Ticket | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next) {
        setOpenTicket(next);
        onApply(next);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addComment = () => {
    const text = commentText.trim();
    if (!text) return;
    return act(async () => {
      const res = await fetch(`${getApiBase()}/api/board/tickets/${encodeURIComponent(ticket.id)}/comments`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ text, author: 'user' }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { comment?: TicketComment };
      if (data.comment) setComments((prev) => [...prev, data.comment!]);
      setCommentText('');
      return openTicket;
    });
  };

  const assignTicket = (agentId: string) => {
    if (!agentId) return;
    return act(async () => {
      const res = await fetch(`${getApiBase()}/api/board/tickets/${encodeURIComponent(ticket.id)}/assign`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      const data = (await res.json()) as { ticket?: Ticket };
      setAssignTo('');
      return data.ticket;
    });
  };

  const unassign = () =>
    act(async () => {
      const res = await fetch(`${getApiBase()}/api/board/tickets/${encodeURIComponent(ticket.id)}/release`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { ticket?: Ticket };
      return data.ticket;
    });

  const index = COLUMNS.findIndex((c) => c.status === openTicket.status);
  const assignee = openTicket.assigneeAgentId ? agentById[openTicket.assigneeAgentId] : undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-[400px] max-w-[90vw] flex-col border-s border-border-main bg-bg-menu"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-row items-center justify-between border-b border-border-main px-3">
          <span className="text-sm font-medium text-text-primary">{t('Ticket')}</span>
          <button type="button" onClick={onClose} className="rounded p-1 text-text-tertiary hover:bg-fill-hover">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <p className="text-sm font-medium text-text-primary">{openTicket.title}</p>
          {openTicket.body && <p className="mt-2 whitespace-pre-wrap text-xs text-text-secondary">{openTicket.body}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${priorityChip[openTicket.priority]}`}>
              {t(openTicket.priority)}
            </span>
            <span className="rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] text-text-tertiary">
              {t(COLUMNS[index]!.label)}
            </span>
            <span className="flex items-center gap-1 rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] text-text-tertiary">
              {assignee ? (
                <>
                  <AgentAvatar name={assignee.name} id={assignee.id} emoji={assignee.emoji} size={14} />
                  {assignee.name}
                </>
              ) : t('Unassigned')}
              {assignee && (
                <button type="button" onClick={() => void unassign()} className="text-text-tertiary hover:text-text-primary">
                  <X className="size-2.5" />
                </button>
              )}
            </span>
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            <p className="text-[11px] font-medium text-text-tertiary">{t('Move to')}</p>
            <div className="flex items-center gap-1">
              {COLUMNS.map((c) => (
                <button
                  key={c.status}
                  type="button"
                  disabled={busy || c.status === openTicket.status}
                  onClick={() => void act(async () => {
                    const res = await fetch(`${getApiBase()}/api/board/tickets/${encodeURIComponent(ticket.id)}`, {
                      method: 'PATCH',
                      headers: await getApiHeaders(),
                      body: JSON.stringify({ status: c.status }),
                    });
                    if (!res.ok) throw new Error(`status ${res.status}`);
                    const data = (await res.json()) as { ticket?: Ticket };
                    return data.ticket;
                  })}
                  className={`flex-1 rounded-control px-1.5 py-1 text-[11px] ${
                    c.status === openTicket.status
                      ? 'bg-fill-tsp text-text-secondary'
                      : 'border border-border-main text-text-secondary hover:bg-fill-hover'
                  }`}
                >
                  {t(c.label)}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-medium text-text-tertiary">{t('Assign to agent')}</p>
            <div className="flex items-center gap-1.5">
              <select
                value={assignTo}
                onChange={(e) => setAssignTo(e.target.value)}
                className="flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-xs text-text-primary outline-none"
              >
                <option value="">{t('Choose an agent')}</option>
                {Object.values(agentById).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !assignTo}
                onClick={() => void assignTicket(assignTo)}
                className="rounded-control border border-border-main px-2.5 py-1.5 text-xs text-text-primary hover:bg-fill-hover disabled:opacity-50"
              >
                {t('Assign')}
              </button>
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-[11px] font-medium text-text-tertiary">{t('Comments')}</p>
            {commentsLoading ? (
              <div className="flex items-center gap-2 py-2 text-xs text-text-secondary">
                <Loader2 className="size-3.5 animate-spin" /> {t('Loading')}
              </div>
            ) : comments.length === 0 ? (
              <p className="py-2 text-xs text-text-tertiary">{t('No comments yet.')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {comments.map((c) => (
                  <div key={c.id} className="rounded-control border border-border-main bg-bg-main p-2">
                    <p className="text-[10px] text-text-tertiary">
                      {c.author} · {new Date(c.createdAt).toLocaleString()}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs text-text-primary">{c.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="border-t border-border-main p-2">
          {error && <p className="mb-1 text-xs text-function-error">{error}</p>}
          <div className="flex items-center gap-1.5">
            <input
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void addComment();
                }
              }}
              placeholder={t('Write a comment')}
              className="flex-1 rounded-control border border-border-main bg-bg-main px-2.5 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
            />
            <button
              type="button"
              disabled={busy || !commentText.trim()}
              onClick={() => void addComment()}
              aria-label={t('Send comment')}
              title={t('Send comment')}
              className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover disabled:opacity-50"
            >
              <Send className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BoardPageClient;
