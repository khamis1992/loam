'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Search,
  ChevronRight,
  Users,
  MoreHorizontal,
  Loader2,
  AlertCircle,
  Store,
  Kanban,
  MessageSquare,
  Pin,
} from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { useAppSelector } from '@/store';
import { Button, Spinner } from '@/components/ui/Button';
import { grokBotNoteText } from '@/components/chat/GrokBotNote';
import type { ChatEvent } from '@shared/socket';
import type { AgentCardAgent } from './AgentCard';
import { AgentContextMenu } from './AgentContextMenu';
import { AgentRow, RowAccent } from './AgentRow';
import { getBuiltInAgents } from './BuiltInAgentCard';
import type { GroupChat } from './groupTypes';
import { foldName, searchAgents, sortByLastActivity, splitHidden, sumUnread } from './agentListFilter';

interface AgentWithMeta extends AgentCardAgent {
  /** Soft-hide timestamp: hidden agents live in the bottom "Hidden" section. */
  hiddenAt?: string;
  archivedAt?: string;
  description?: string;
  instructions?: string;
  effort?: string;
  allowedServices?: string[];
  /** Additive chat metadata served with the agents list (GET /api/agents). */
  lastMessage?: string;
  waitingForYou?: boolean;
  unreadCount?: number;
  lastActivityAt?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface UnreadInfo {
  count: number;
  lastAt?: string;
}

interface ChildAgent {
  childId: string;
  spawnKey: string;
  name: string;
  emoji: string;
  description: string;
  mode?: string;
  archived: boolean;
  createdAt: string;
}

interface AgentSidebarListProps {
  agents: AgentWithMeta[];
  selectedId?: string;
  loading?: boolean;
  error?: string | null;
  onSelect: (agent: AgentWithMeta) => void;
  onNew: () => void;
  onEdit: (agent: AgentWithMeta) => void;
  onDuplicate: (agent: AgentWithMeta) => void;
  onArchive: (agent: AgentWithMeta) => void;
  onHideAgent?: (agent: AgentWithMeta, hidden: boolean) => void;
  /** Toggles the agent's pinned state (Pinned section at the top). */
  onTogglePin?: (agent: AgentWithMeta) => void;
  /** Persists a new pinned order (ids from first to last). */
  onReorderPinned?: (ids: string[]) => void;
  /** Opens the info pane for the agent. */
  onInfo?: (agent: AgentWithMeta) => void;
  /** Opens the rename dialog for the agent. */
  onRename?: (agent: AgentWithMeta) => void;
  /** Permanently deletes the agent (confirm is shown by the context menu). */
  onDeleteAgent?: (agent: AgentWithMeta) => void;
  onStartBuiltIn?: (agent: AgentCardAgent) => void;
  unreadById?: Record<string, UnreadInfo>;
  teamRunsLoading?: boolean;
  teamRunsError?: string | null;
  groups?: GroupChat[];
  selectedGroupId?: string;
  onSelectGroup?: (group: GroupChat) => void;
  onNewGroup?: () => void;
}

const SECTIONS = {
  pinned: 'pinned',
  myAgents: 'my-agents',
  groups: 'groups',
  builtIn: 'built-in',
  teamRuns: 'team-runs',
  hidden: 'hidden',
} as const;

const storageKey = (id: string) => `loam.agents.section.${id}`;

const EMPTY_SEARCH_TEXT = t('No matches');

/** Character cap for the gray preview line; CSS truncation clips the rest. */
const SUBTITLE_MAX_CHARS = 96;

/** One-line, whitespace-collapsed preview of a message or description. */
function previewLine(text: string): string {
  const flat = grokBotNoteText(text).trim().replace(/\s+/g, ' ');
  return flat.length > SUBTITLE_MAX_CHARS ? `${flat.slice(0, SUBTITLE_MAX_CHARS)}…` : flat;
}

/** Latest user/assistant chat message of a thread as a preview (null when none). */
function lastThreadEvent(events: ChatEvent[] | undefined): { text: string; waiting: boolean } | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'chat') continue;
    const line = previewLine(e.content ?? '');
    if (line) return { text: line, waiting: e.sender === 'assistant' };
  }
  return null;
}

export function AgentSidebarList({
  agents,
  selectedId,
  loading,
  error,
  onSelect,
  onNew,
  onEdit,
  onDuplicate,
  onArchive,
  onHideAgent,
  onTogglePin,
  onReorderPinned,
  onInfo,
  onRename,
  onDeleteAgent,
  onStartBuiltIn,
  unreadById,
  groups = [],
  selectedGroupId,
  onSelectGroup,
  onNewGroup,
}: AgentSidebarListProps) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [sections, setSections] = useState<Record<(string), boolean>>(() => {
    if (typeof window === 'undefined') return {};
    const out: Record<(string), boolean> = {};
    out[SECTIONS.pinned] = localStorage.getItem(storageKey(SECTIONS.pinned)) !== 'false';
    out[SECTIONS.myAgents] = localStorage.getItem(storageKey(SECTIONS.myAgents)) !== 'false';
    out[SECTIONS.groups] = localStorage.getItem(storageKey(SECTIONS.groups)) !== 'false';
    out[SECTIONS.builtIn] = localStorage.getItem(storageKey(SECTIONS.builtIn)) !== 'false';
    out[SECTIONS.teamRuns] = localStorage.getItem(storageKey(SECTIONS.teamRuns)) === 'true';
    out[SECTIONS.hidden] = localStorage.getItem(storageKey(SECTIONS.hidden)) !== 'false';
    return out;
  });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    agent: AgentWithMeta;
  } | null>(null);
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ChildAgent[]>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  const trimmedSearch = search.trim();
  // Search spans all sections: visible, hidden, groups and built-in (diacritic-insensitive).
  const searchActive = foldName(trimmedSearch).length > 0;
  const builtInAgents = useMemo(() => getBuiltInAgents(), []);

  const filteredAgents = useMemo(
    () => searchAgents(agents, search),
    [agents, search],
  );

  const { visible: searchVisibleAgents, hidden: searchHiddenAgents } = useMemo(
    () => splitHidden(filteredAgents),
    [filteredAgents],
  );

  const filteredGroups = useMemo(
    () => (searchActive ? groups.filter((g) => foldName(g.name).includes(foldName(trimmedSearch))) : groups),
    [groups, searchActive, trimmedSearch],
  );

  const filteredBuiltIn = useMemo(
    () => searchAgents(builtInAgents, search),
    [builtInAgents, search],
  );

  const noSearchMatches =
    searchActive &&
    searchVisibleAgents.length === 0 &&
    searchHiddenAgents.length === 0 &&
    filteredGroups.length === 0 &&
    filteredBuiltIn.length === 0;

  // MF6: child agents live under their parent, not as top-level entries.
  const agentIdsKey = useMemo(() => agents.map((a) => a.id).join(','), [agents]);

  useEffect(() => {
    let mounted = true;
    const ids = agentIdsKey ? agentIdsKey.split(',') : [];
    if (ids.length === 0) {
      setChildrenByParent({});
      return;
    }
    (async () => {
      const entries = await Promise.all(
        ids.map(async (id): Promise<[string, ChildAgent[]]> => {
          try {
            const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(id)}/children`, {
              headers: await getApiHeaders(),
            });
            if (!res.ok) return [id, []];
            const data = (await res.json()) as { children?: ChildAgent[] };
            return [id, data.children ?? []];
          } catch {
            return [id, []];
          }
        }),
      );
      if (mounted) setChildrenByParent(Object.fromEntries(entries));
    })();
    return () => { mounted = false; };
  }, [agentIdsKey]);

  // Grok Bot parity: agentId -> thread uid map so rows can preview the last message.
  const eventsBySession = useAppSelector((s) => s.chat.eventsBySession);
  const [threadUidByAgent, setThreadUidByAgent] = useState<Record<string, string>>({});
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agent-threads`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { threads?: Array<{ agentId?: string; threadUid?: string }> };
        if (!mounted) return;
        const next: Record<string, string> = {};
        for (const item of data.threads ?? []) {
          if (item?.agentId && item?.threadUid) next[item.agentId] = item.threadUid;
        }
        setThreadUidByAgent(next);
      } catch {
        // Subtitle falls back to the agent description.
      }
    })();
    return () => { mounted = false; };
  }, [agentIdsKey, selectedId]);

  const childAgentIds = useMemo(
    () => new Set(Object.values(childrenByParent).flat().map((c) => c.childId)),
    [childrenByParent],
  );

  const topLevelAgents = useMemo(
    () => searchVisibleAgents.filter((a) => !childAgentIds.has(a.id)),
    [searchVisibleAgents, childAgentIds],
  );

  // Pinned agents float above My agents, ordered by user-defined sortOrder.
  const rankedPinned = useMemo(
    () => topLevelAgents
      .filter((a) => typeof a.pinnedAt === 'number')
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)),
    [topLevelAgents],
  );
  // Grok Bot parity: non-pinned rows are a flat conversation list, most recent activity first.
  const myAgents = useMemo(
    () => sortByLastActivity(topLevelAgents.filter((a) => typeof a.pinnedAt !== 'number')),
    [topLevelAgents],
  );
  const hiddenAgents = useMemo(() => sortByLastActivity(searchHiddenAgents), [searchHiddenAgents]);

  const pinnedById = useMemo(() => new Map(rankedPinned.map((a) => [a.id, a])), [rankedPinned]);

  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  useEffect(() => {
    setPinnedOrder(rankedPinned.map((a) => a.id));
  }, [rankedPinned]);

  const orderMatches = rankedPinned.length === pinnedOrder.length
    && pinnedOrder.every((id) => pinnedById.has(id));
  const displayPinned = orderMatches ? pinnedOrder.map((id) => pinnedById.get(id)!) : rankedPinned;

  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[]>([]);
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean; order: string[] } | null>(null);
  const suppressClickRef = useRef(false);

  const commitPinnedOrder = (ids: string[]) => {
    setPinnedOrder(ids);
    onReorderPinned?.(ids);
  };
  const commitPinnedOrderRef = useRef(commitPinnedOrder);
  commitPinnedOrderRef.current = commitPinnedOrder;

  useEffect(() => {
    if (!onReorderPinned) return;
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.moved) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (dx * dx + dy * dy < 36) return;
        drag.moved = true;
        dragOrderRef.current = [...drag.order];
        setDragOrder([...drag.order]);
      }
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const overId = el?.closest('[data-pinned-id]')?.getAttribute('data-pinned-id') ?? null;
      if (!overId || overId === drag.id) return;
      const order = [...dragOrderRef.current];
      const from = order.indexOf(drag.id);
      const to = order.indexOf(overId);
      if (from === -1 || to === -1 || from === to) return;
      order.splice(from, 1);
      order.splice(to, 0, drag.id);
      dragOrderRef.current = order;
      setDragOrder(order);
    };
    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setDragOrder(null);
      if (drag.moved && e.type === 'pointerup') {
        suppressClickRef.current = true;
        commitPinnedOrderRef.current(dragOrderRef.current.length ? dragOrderRef.current : drag.order);
      }
      dragOrderRef.current = [];
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [onReorderPinned]);

  const handlePinnedPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 || !onReorderPinned) return;
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false, order: displayPinned.map((a) => a.id) };
  };

  const handlePinnedKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const order = displayPinned.map((a) => a.id);
    const from = order.indexOf(id);
    const to = e.key === 'ArrowUp' ? from - 1 : from + 1;
    if (from === -1 || to < 0 || to >= order.length) return;
    e.preventDefault();
    order.splice(to, 0, order.splice(from, 1)[0]);
    commitPinnedOrder(order);
  };

  // Swallow the click that follows a drag so it does not select a new agent.
  const guardSelect = (agent: AgentWithMeta) => () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(agent);
  };

  // Row meta: prefer the live client store for the open thread, else the server
  // list's additive chat fields, else the agent description.
  const rowMeta = (agent: AgentCardAgent) => {
    const uid = threadUidByAgent[agent.id];
    const live = uid ? lastThreadEvent(eventsBySession[uid]) : null;
    const meta = agent as AgentWithMeta;
    const subtitle = live?.text || meta.lastMessage || (agent.description ? previewLine(agent.description) : '');
    const waitingForYou = live ? live.waiting : Boolean(meta.waitingForYou);
    const unreadCount = unreadById?.[agent.id]?.count ?? meta.unreadCount ?? 0;
    return { subtitle, waitingForYou, unreadCount };
  };

  const renderAgentTree = (agent: AgentWithMeta, pinned = false) => {
    const meta = rowMeta(agent);
    return (
      <div key={agent.id} className="flex flex-col gap-0.5">
        <AgentRow
          agent={agent}
          selected={selectedId === agent.id}
          subtitle={meta.subtitle}
          waitingForYou={meta.waitingForYou}
          unreadCount={meta.unreadCount}
          onClick={pinned ? guardSelect(agent) : () => onSelect(agent)}
          onContextMenu={(e) => handleContextMenu(e, agent)}
          drag={pinned ? {
            'data-pinned-id': agent.id,
            onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => handlePinnedPointerDown(e, agent.id),
            onKeyDown: (e: React.KeyboardEvent) => handlePinnedKeyDown(e, agent.id),
          } : undefined}
        />
        {(childrenByParent[agent.id] ?? []).map((child) => {
          const childAgent: AgentWithMeta = {
            id: child.childId,
            name: child.name,
            emoji: child.emoji,
            description: child.description,
            mode: child.mode,
          };
          const childMeta = rowMeta(childAgent);
          return (
            <AgentRow
              key={child.childId}
              agent={childAgent}
              selected={selectedId === child.childId}
              subtitle={childMeta.subtitle}
              waitingForYou={childMeta.waitingForYou}
              unreadCount={childMeta.unreadCount}
              indent
              onClick={() => onSelect(childAgent)}
              onContextMenu={(e) => handleContextMenu(e, childAgent)}
            />
          );
        })}
      </div>
    );
  };

  // Section-header unread sums; sumUnread stubs to 0 when no unread source is wired.
  const pinnedAgentIds = useMemo(
    () => [
      ...rankedPinned.map((a) => a.id),
      ...rankedPinned.flatMap((a) => (childrenByParent[a.id] ?? []).map((c) => c.childId)),
    ],
    [rankedPinned, childrenByParent],
  );
  const pinnedUnread = sumUnread(pinnedAgentIds, unreadById);
  const myAgentIds = useMemo(
    () => [
      ...myAgents.map((a) => a.id),
      ...myAgents.flatMap((a) => (childrenByParent[a.id] ?? []).map((c) => c.childId)),
    ],
    [myAgents, childrenByParent],
  );
  const myAgentsUnread = sumUnread(myAgentIds, unreadById);
  const hiddenUnread = sumUnread(searchHiddenAgents.map((a) => a.id), unreadById);

  const toggleSection = (id: string) => {
    setSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem(storageKey(id), String(next[id]));
      return next;
    });
  };

  const handleContextMenu = (
    e: React.MouseEvent,
    agent: AgentWithMeta,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, agent });
  };

  const handleArchive = (agent: AgentWithMeta) => {
    setContextMenu(null);
    if (window.confirm(t('Archive {name}? This agent will be hidden but can be restored later.', { name: agent.name }))) {
      onArchive(agent);
    }
  };

  if (loading) {
    return (
      <aside className="flex w-[260px] shrink-0 flex-col border-e border-border-main bg-bg-menu">
        <div className="flex h-row items-center justify-between border-b border-border-main px-3">
          <span className="text-sm font-medium text-text-primary">{t('Agents')}</span>
        </div>
        <div className="flex flex-1 items-center justify-center text-text-secondary">
          <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
        </div>
      </aside>
    );
  }

  if (error) {
    return (
      <aside className="flex w-[260px] shrink-0 flex-col border-e border-border-main bg-bg-menu">
        <div className="flex h-row items-center justify-between border-b border-border-main px-3">
          <span className="text-sm font-medium text-text-primary">{t('Agents')}</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-function-error">
          <AlertCircle className="size-5" />
          <p className="text-center text-xs">{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>
            {t('Retry')}
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-e border-border-main bg-bg-menu">
      <div className="flex h-row items-center justify-between border-b border-border-main px-3">
        <span className="text-sm font-medium text-text-primary">{t('Agents')}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onNew}
          className="h-row-sm w-row-sm px-0"
          aria-label={t('New agent')}
          title={t('New agent')}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="p-2">
        <div className="flex items-center gap-2 rounded-control border border-border-main bg-bg-main px-2 py-1.5">
          <Search className="size-3.5 text-text-tertiary" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Search agents')}
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <button
          type="button"
          onClick={() => router.push('/app/marketplace')}
          className="mt-1 flex h-row-sm w-full items-center gap-2 rounded-control px-2 text-sm text-text-secondary hover:bg-fill-hover"
        >
          <Store className="size-4" />
          <span className="flex-1 truncate text-start">{t('Marketplace')}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {rankedPinned.length > 0 && (
          <AgentSection
            id={SECTIONS.pinned}
            label={t('Pinned')}
            count={rankedPinned.length}
            icon={Pin}
            expanded={!!sections[SECTIONS.pinned]}
            onToggle={() => toggleSection(SECTIONS.pinned)}
            unread={pinnedUnread}
          >
            {(dragOrder
              ? dragOrder
                  .map((id) => pinnedById.get(id))
                  .filter((a): a is AgentWithMeta => Boolean(a))
              : displayPinned
            ).map((agent) => renderAgentTree(agent, true))}
          </AgentSection>
        )}

        <AgentSection
          id={SECTIONS.myAgents}
          label={t('My agents')}
          count={myAgents.length}
          expanded={!!sections[SECTIONS.myAgents]}
          onToggle={() => toggleSection(SECTIONS.myAgents)}
          unread={myAgentsUnread}
        >
          {myAgents.length === 0 ? (
            <p className="px-2 py-3 text-xs text-text-tertiary">
              {searchActive ? EMPTY_SEARCH_TEXT : t('No agents yet.')}
            </p>
          ) : (
            myAgents.map((agent) => renderAgentTree(agent))
          )}
        </AgentSection>

        <AgentSection
          id={SECTIONS.groups}
          label={t('Groups')}
          count={filteredGroups.length}
          icon={MessageSquare}
          expanded={!!sections[SECTIONS.groups]}
          onToggle={() => toggleSection(SECTIONS.groups)}
          action={
            onNewGroup ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewGroup();
                }}
                className="rounded-control p-0.5 text-text-tertiary hover:text-text-primary"
                aria-label={t('New group')}
                title={t('New group')}
              >
                <Plus className="size-3.5" />
              </button>
            ) : undefined
          }
        >
          {filteredGroups.length === 0 ? (
            <p className="px-2 py-3 text-xs text-text-tertiary">
              {searchActive ? EMPTY_SEARCH_TEXT : t('No groups yet.')}
            </p>
          ) : (
            filteredGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => onSelectGroup?.(group)}
                className={[
                  'group relative flex h-row items-center gap-2 rounded-control px-2 text-start transition-colors',
                  selectedGroupId === group.id ? 'bg-fill-tsp' : 'hover:bg-fill-hover',
                ].join(' ')}
              >
                {selectedGroupId === group.id && <RowAccent />}
                <div className="flex size-7 shrink-0 items-center justify-center rounded-control bg-fill-tsp">
                  <Users className="size-3.5 text-text-secondary" />
                </div>
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{group.name}</span>
                <span className="shrink-0 text-[11px] text-text-tertiary">{group.memberIds.length}</span>
              </button>
            ))
          )}
        </AgentSection>

        <AgentSection
          id={SECTIONS.builtIn}
          label={t('Built-in')}
          count={filteredBuiltIn.length}
          expanded={!!sections[SECTIONS.builtIn]}
          onToggle={() => toggleSection(SECTIONS.builtIn)}
        >
          {filteredBuiltIn.length === 0 ? (
            <p className="px-2 py-3 text-xs text-text-tertiary">{EMPTY_SEARCH_TEXT}</p>
          ) : (
            filteredBuiltIn.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={false}
                subtitle={agent.description ? previewLine(agent.description) : undefined}
                onClick={() => onStartBuiltIn?.(agent)}
                onContextMenu={() => {}}
              />
            ))
          )}
        </AgentSection>

        <BoardLink />
        <AgentSection
          id={SECTIONS.teamRuns}
          label={t('Team runs')}
          icon={Users}
          expanded={!!sections[SECTIONS.teamRuns]}
          onToggle={() => toggleSection(SECTIONS.teamRuns)}
        >
          <TeamRunsCompact />
        </AgentSection>

        {searchHiddenAgents.length > 0 && (
          <AgentSection
            id={SECTIONS.hidden}
            label={t('Hidden')}
            count={searchHiddenAgents.length}
            expanded={!!sections[SECTIONS.hidden]}
            onToggle={() => toggleSection(SECTIONS.hidden)}
            unread={hiddenUnread}
          >
            {hiddenAgents.map((agent) => {
              const meta = rowMeta(agent);
              return (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  selected={selectedId === agent.id}
                  subtitle={meta.subtitle}
                  waitingForYou={meta.waitingForYou}
                  unreadCount={meta.unreadCount}
                  indent
                  dim
                  onClick={() => onSelect(agent)}
                  onContextMenu={(e) => handleContextMenu(e, agent)}
                />
              );
            })}
          </AgentSection>
        )}

        {noSearchMatches && (
          <p className="px-2 py-6 text-center text-xs text-text-tertiary">
            {t('No agents match "{search}"', { search })}
          </p>
        )}
      </div>

      {contextMenu && (
        <AgentContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          agentName={contextMenu.agent.name}
          pinned={typeof contextMenu.agent.pinnedAt === 'number'}
          hidden={!!contextMenu.agent.hiddenAt}
          onOpen={() => onSelect(contextMenu.agent)}
          onInfo={() => onInfo?.(contextMenu.agent)}
          onRename={() => onRename?.(contextMenu.agent)}
          onTogglePin={() => onTogglePin?.(contextMenu.agent)}
          onToggleHide={() => onHideAgent?.(contextMenu.agent, !contextMenu.agent.hiddenAt)}
          onEdit={() => onEdit(contextMenu.agent)}
          onDuplicate={() => onDuplicate(contextMenu.agent)}
          onArchive={() => handleArchive(contextMenu.agent)}
          onDelete={() => onDeleteAgent?.(contextMenu.agent)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </aside>
  );
}

function SectionHeader({
  label,
  count,
  unread = 0,
  expanded,
  onToggle,
  icon: Icon,
  action,
}: SectionHeaderProps) {
  return (
    <div className="mt-2 flex h-row-sm w-full items-center rounded-control px-2 text-[13px] font-semibold text-text-secondary hover:bg-fill-hover">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
      >
        {Icon && <Icon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{label}</span>
        {typeof count === 'number' && (
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-text-tertiary">{count}</span>
        )}
        {unread > 0 && (
          <span
            className="shrink-0 rounded-full px-1.5 text-[10px] font-medium text-text-primary"
            style={{ backgroundColor: 'var(--activity-indicator-running)' }}
            title={t('{count} unread', { count: unread })}
          >
            {unread}
          </span>
        )}
      </button>
      {action}
      <ChevronRight
        className={`ms-1 size-3.5 shrink-0 text-text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
        aria-hidden
      />
    </div>
  );
}

interface SectionHeaderProps {
  label: string;
  count?: number;
  unread?: number;
  expanded: boolean;
  onToggle: () => void;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
}

function AgentSection({
  id,
  label,
  count,
  unread,
  expanded,
  onToggle,
  icon,
  action,
  children,
}: SectionHeaderProps & { id: string; children: ReactNode }) {
  return (
    <section data-agents-section={id}>
      <SectionHeader
        label={label}
        count={count}
        unread={unread}
        expanded={expanded}
        onToggle={onToggle}
        icon={icon}
        action={action}
      />
      {expanded && <div className="flex flex-col gap-0.5">{children}</div>}
    </section>
  );
}

function BoardLink() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push('/app/board')}
      className="mt-2 flex h-row-sm w-full items-center gap-1.5 rounded-control px-2 text-xs font-medium text-text-secondary hover:bg-fill-hover"
    >
      <Kanban className="size-3.5" />
      {t('Board')}
    </button>
  );
}

function TeamRunsCompact() {
  interface Run {
    id: string;
    brief?: string;
    status?: string;
  }
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/swarm/runs`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { runs?: Run[] };
        if (mounted) setRuns(data.runs ?? []);
      } catch (e) {
        if (mounted) setRuns([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-2 py-3 text-xs text-text-secondary">
        <Spinner className="size-3.5" /> {t('Loading')}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-text-tertiary">{t('No team runs yet.')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 py-1">
      {runs.slice(0, 6).map((run) => (
        <div
          key={run.id}
          className="flex items-center gap-2 rounded-control px-2 py-1.5 text-start hover:bg-fill-hover"
        >
          <MoreHorizontal className="size-3.5 text-text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{run.brief || run.id}</span>
          <span className="shrink-0 rounded-full bg-fill-tsp px-1.5 py-0 text-[10px] text-text-tertiary">
            {run.status || 'unknown'}
          </span>
        </div>
      ))}
    </div>
  );
}
