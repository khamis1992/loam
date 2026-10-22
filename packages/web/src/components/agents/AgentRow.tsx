'use client';

import { t } from '@/i18n/t';
import { AgentAvatar } from './AgentAvatar';
import type { AgentCardAgent } from './AgentCard';

/**
 * Grok Bot-style conversation row: a compact 32px avatar, the agent name in
 * medium weight with a small grey role chip, a single-line last-message snippet
 * (orange "Waiting for you: …" when the agent replied last) and a far-right
 * status dot (blue = unread, orange = waiting). The row is intentionally free of
 * extra badges so the list stays flat and scannable.
 */

/** Pointer/keyboard drag handles attached to pinned rows. */
export interface AgentRowDragProps {
  'data-pinned-id': string;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

/** Far-right status dot state: waiting wins over unread, which wins over idle. */
export type AgentRowDotState = 'waiting' | 'unread' | 'idle';

/** Waiting (agent's turn is over) beats unread; no dot when neither applies. */
export function agentRowDotState(waitingForYou: boolean, unreadCount: number): AgentRowDotState {
  if (waitingForYou) return 'waiting';
  if (unreadCount > 0) return 'unread';
  return 'idle';
}

/** Small role chip text: the agent's mode (or work mode) when one is set. */
export function agentRoleChip(agent: Pick<AgentCardAgent, 'mode' | 'workMode'>): string | undefined {
  const value = agent.mode?.trim() || agent.workMode?.trim();
  return value ? value : undefined;
}

export interface AgentRowProps {
  agent: AgentCardAgent;
  selected?: boolean;
  /** One-line preview: latest thread message (server meta) or the description. */
  subtitle?: string;
  /** True when the agent replied last and the user's turn is next. */
  waitingForYou?: boolean;
  /** Unread message count; renders the far-right dot when greater than 0. */
  unreadCount?: number;
  indent?: boolean;
  dim?: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  drag?: AgentRowDragProps;
}

/** Dot fill per state; inline CSS vars keep it consistent with the other dots. */
const DOT_COLORS: Record<Exclude<AgentRowDotState, 'idle'>, string> = {
  waiting: 'var(--function-warning)',
  unread: 'var(--icon-blue)',
};

export function AgentRow({
  agent,
  selected = false,
  subtitle,
  waitingForYou = false,
  unreadCount = 0,
  indent,
  dim,
  onClick,
  onContextMenu,
  drag,
}: AgentRowProps) {
  const role = agentRoleChip(agent);
  const dotState = agentRowDotState(waitingForYou, unreadCount);
  const snippet = subtitle?.trim() ?? '';
  const snippetText = waitingForYou
    ? snippet
      ? t('Waiting for you: {message}', { message: snippet })
      : t('Waiting for you')
    : snippet;

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-current={selected ? 'true' : undefined}
      data-agent-row={agent.id}
      {...(unreadCount > 0 ? { 'data-unread-row': '' } : {})}
      {...(drag ?? {})}
      className={[
        'group relative flex min-h-[52px] items-center gap-2 rounded-control px-2 py-1.5 text-start transition-colors',
        indent ? 'ps-6' : '',
        dim ? 'opacity-60' : '',
        selected ? 'bg-fill-tsp' : 'hover:bg-fill-hover',
        drag ? 'cursor-grab select-none active:cursor-grabbing' : '',
      ].join(' ')}
      aria-label={drag ? t('Pinned agent {name}. Alt+ArrowUp or Alt+ArrowDown to reorder, drag to reorder.', { name: agent.name }) : undefined}
    >
      {selected && <RowAccent />}
      <AgentAvatar
        name={agent.name}
        avatarShape={agent.avatarShape}
        avatarColor={agent.avatarColor}
        avatarImage={agent.avatarImage}
        size={32}
        selected={selected}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-text-primary">{agent.name}</span>
          {role && (
            <span
              data-agent-chip={role}
              title={t('Role')}
              className="shrink-0 rounded-full border border-border-main bg-fill-tsp px-1.5 py-0.5 text-[10px] leading-none text-text-tertiary"
            >
              {role}
            </span>
          )}
        </span>
        {snippetText ? (
          <span
            data-agent-snippet={waitingForYou ? 'waiting' : 'last'}
            className={`min-w-0 truncate text-xs ${waitingForYou ? 'text-func-warning' : 'text-text-tertiary'}`}
          >
            {snippetText}
          </span>
        ) : null}
      </span>
      {dotState !== 'idle' && (
        <span
          data-agent-dot={dotState}
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: DOT_COLORS[dotState] }}
          aria-label={dotState === 'waiting' ? t('Waiting for you') : t('{count} unread', { count: unreadCount })}
        />
      )}
    </button>
  );
}

/** Selected-row accent bar, shared with the group rows. */
export function RowAccent() {
  return (
    <span
      className="pointer-events-none absolute inset-y-1 start-0 w-[3px] rounded-full"
      style={{ backgroundColor: 'var(--activity-indicator-running)' }}
      aria-hidden
    />
  );
}
