'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Search,
  ChevronRight,
  Users,
  MoreHorizontal,
  Copy,
  Pencil,
  Archive,
  ExternalLink,
  Loader2,
  AlertCircle,
  Store,
  Kanban,
  MessageSquare,
  Eye,
  EyeOff,
} from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Button, Spinner } from '@/components/ui/Button';
import type { AgentCardAgent } from './AgentCard';
import { GrokBotBadge, isGrokBotAgent } from './GrokBotBadge';
import { AgentAvatar } from './AgentAvatar';
import { getBuiltInAgents } from './BuiltInAgentCard';
import type { GroupChat } from './groupTypes';
import { foldName, searchAgents, splitHidden, sumUnread } from './agentListFilter';

interface AgentWithMeta extends AgentCardAgent {
  /** Soft-hide timestamp: hidden agents live in the bottom "Hidden" section. */
  hiddenAt?: string;
  archivedAt?: string;
  description?: string;
  instructions?: string;
  effort?: string;
  allowedServices?: string[];
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
  myAgents: 'my-agents',
  groups: 'groups',
  builtIn: 'built-in',
  teamRuns: 'team-runs',
  hidden: 'hidden',
} as const;

const storageKey = (id: string) => `loam.agents.section.${id}`;

const EMPTY_SEARCH_TEXT = t('No matches');

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
  const menuRef = useRef<HTMLDivElement>(null);
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

  const childAgentIds = useMemo(
    () => new Set(Object.values(childrenByParent).flat().map((c) => c.childId)),
    [childrenByParent],
  );

  const topLevelAgents = useMemo(
    () => searchVisibleAgents.filter((a) => !childAgentIds.has(a.id)),
    [searchVisibleAgents, childAgentIds],
  );

  // Section-header unread sums; sumUnread stubs to 0 when no unread source is wired.
  const myAgentIds = useMemo(
    () => [
      ...topLevelAgents.map((a) => a.id),
      ...topLevelAgents.flatMap((a) => (childrenByParent[a.id] ?? []).map((c) => c.childId)),
    ],
    [topLevelAgents, childrenByParent],
  );
  const myAgentsUnread = sumUnread(myAgentIds, unreadById);
  const hiddenUnread = sumUnread(searchHiddenAgents.map((a) => a.id), unreadById);

  useEffect(() => {
    if (!contextMenu) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

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
        <AgentSection
          id={SECTIONS.myAgents}
          label={t('My agents')}
          count={topLevelAgents.length}
          expanded={!!sections[SECTIONS.myAgents]}
          onToggle={() => toggleSection(SECTIONS.myAgents)}
          unread={myAgentsUnread}
        >
          {topLevelAgents.length === 0 ? (
            <p className="px-2 py-3 text-xs text-text-tertiary">
              {searchActive ? EMPTY_SEARCH_TEXT : t('No agents yet.')}
            </p>
          ) : (
            topLevelAgents.map((agent) => (
              <div key={agent.id} className="flex flex-col gap-0.5">
                <AgentRow
                  agent={agent}
                  selected={selectedId === agent.id}
                  unread={unreadById?.[agent.id]?.count ?? 0}
                  onClick={() => onSelect(agent)}
                  onContextMenu={(e) => handleContextMenu(e, agent)}
                />
                {(childrenByParent[agent.id] ?? []).map((child) => {
                  const childAgent: AgentWithMeta = {
                    id: child.childId,
                    name: child.name,
                    emoji: child.emoji,
                    description: child.description,
                    mode: child.mode,
                  };
                  return (
                    <AgentRow
                      key={child.childId}
                      agent={childAgent}
                      selected={selectedId === child.childId}
                      unread={unreadById?.[child.childId]?.count ?? 0}
                      indent
                      onClick={() => onSelect(childAgent)}
                      onContextMenu={(e) => handleContextMenu(e, childAgent)}
                    />
                  );
                })}
              </div>
            ))
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
                  selectedGroupId === group.id ? 'bg-fill-hover' : 'hover:bg-fill-hover',
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
            {searchHiddenAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={selectedId === agent.id}
                unread={unreadById?.[agent.id]?.count ?? 0}
                indent
                dim
                onClick={() => onSelect(agent)}
                onContextMenu={(e) => handleContextMenu(e, agent)}
              />
            ))}
          </AgentSection>
        )}

        {noSearchMatches && (
          <p className="px-2 py-6 text-center text-xs text-text-tertiary">
            {t('No agents match "{search}"', { search })}
          </p>
        )}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-card border border-border-main bg-bg-menu py-1 shadow-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <ContextItem
            icon={<ExternalLink className="size-4" />}
            label={t('Open')}
            onClick={() => {
              onSelect(contextMenu.agent);
              setContextMenu(null);
            }}
          />
          <ContextItem
            icon={<Pencil className="size-4" />}
            label={t('Edit')}
            onClick={() => {
              onEdit(contextMenu.agent);
              setContextMenu(null);
            }}
          />
          <ContextItem
            icon={<Copy className="size-4" />}
            label={t('Duplicate')}
            onClick={() => {
              onDuplicate(contextMenu.agent);
              setContextMenu(null);
            }}
          />
          {contextMenu.agent.hiddenAt ? (
            <ContextItem
              icon={<Eye className="size-4" />}
              label={t('Unhide')}
              onClick={() => {
                onHideAgent?.(contextMenu.agent, false);
                setContextMenu(null);
              }}
            />
          ) : (
            <ContextItem
              icon={<EyeOff className="size-4" />}
              label={t('Hide')}
              onClick={() => {
                onHideAgent?.(contextMenu.agent, true);
                setContextMenu(null);
              }}
            />
          )}
          <div className="my-1 border-t border-border-main" />
          <ContextItem
            icon={<Archive className="size-4" />}
            label={t('Archive')}
            className="text-function-error"
            onClick={() => handleArchive(contextMenu.agent)}
          />
        </div>
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
    <div className="mt-2 flex h-row-sm w-full items-center rounded-control px-2 text-xs font-medium text-text-secondary hover:bg-fill-hover">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
      >
        {Icon && <Icon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{label}</span>
        {typeof count === 'number' && (
          <span className="shrink-0 text-[11px] text-text-tertiary">{count}</span>
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

function AgentRow({
  agent,
  selected,
  unread,
  indent,
  dim,
  onClick,
  onContextMenu,
}: {
  agent: AgentCardAgent;
  selected: boolean;
  unread?: number;
  indent?: boolean;
  dim?: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-current={selected ? 'true' : undefined}
      className={[
        'group relative flex h-row items-center gap-2 rounded-control px-2 text-start transition-colors',
        indent ? 'ps-6' : '',
        dim ? 'opacity-60' : '',
        selected ? 'bg-fill-hover' : 'hover:bg-fill-hover',
      ].join(' ')}
    >
      {selected && <RowAccent />}
      <AgentAvatar
        name={agent.name}
        avatarShape={agent.avatarShape}
        avatarColor={agent.avatarColor}
        avatarImage={agent.avatarImage}
        size={28}
        selected={selected}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{agent.name}</span>
      {isGrokBotAgent(agent.source) && <GrokBotBadge />}
      {!!unread && unread > 0 && (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: 'var(--activity-indicator-running)' }}
          aria-label={t('{count} unread', { count: unread })}
          title={t('{count} unread', { count: unread })}
        />
      )}
    </button>
  );
}

function RowAccent() {
  return (
    <span
      className="pointer-events-none absolute inset-y-1 start-0 w-[3px] rounded-full"
      style={{ backgroundColor: 'var(--activity-indicator-running)' }}
      aria-hidden
    />
  );
}

function ContextItem({
  icon,
  label,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-fill-hover',
        className ?? '',
      ].join(' ')}
    >
      <span className="text-text-secondary">{icon}</span>
      {label}
    </button>
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
