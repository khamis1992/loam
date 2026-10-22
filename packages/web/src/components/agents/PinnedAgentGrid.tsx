'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/i18n/t';
import type { AgentCardAgent } from './AgentCard';
import { AgentAvatar } from './AgentAvatar';

/** Tile avatar edge length in px (Grok Bot parity: large ~48px avatar tiles). */
const TILE_AVATAR_SIZE = 48;

/** One-line role text under the tile name (mode chip, else description). */
function tileRole(agent: AgentCardAgent): string {
  const raw = (agent.mode ?? agent.description ?? '').trim();
  return raw ? raw.replace(/\s+/g, ' ') : '';
}

interface PinnedAgentGridProps<T extends AgentCardAgent> {
  /** Pinned agents in persisted order (first = top-left tile). */
  agents: T[];
  selectedId?: string;
  unreadById?: Record<string, { count?: number }>;
  onSelect: (agent: T) => void;
  onContextMenu: (e: React.MouseEvent, agent: T) => void;
  /** Persists a new pinned order (ids from first to last). */
  onReorder?: (ids: string[]) => void;
}

/**
 * Grok Bot-style pinned section body: a grid of large avatar tiles
 * (3 per row) with the agent name and a one-line role under the avatar,
 * an unread/status dot on the avatar corner, and a light grey rounded
 * fill on the selected tile. Tiles stay drag-reorderable (pointer drag
 * or Alt+ArrowUp/ArrowDown) and keep the row context menu.
 */
export function PinnedAgentGrid<T extends AgentCardAgent>({
  agents,
  selectedId,
  unreadById,
  onSelect,
  onContextMenu,
  onReorder,
}: PinnedAgentGridProps<T>) {
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // Optimistic local order: survives re-renders until the persisted list confirms it.
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  useEffect(() => {
    setPinnedOrder(agents.map((a) => a.id));
  }, [agents]);

  const orderMatches = agents.length === pinnedOrder.length
    && pinnedOrder.every((id) => agentsById.has(id));
  const displayPinned = orderMatches
    ? pinnedOrder.map((id) => agentsById.get(id)!)
    : agents;

  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[]>([]);
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean; order: string[] } | null>(null);
  const suppressClickRef = useRef(false);

  const commitPinnedOrder = (ids: string[]) => {
    setPinnedOrder(ids);
    onReorder?.(ids);
  };
  const commitPinnedOrderRef = useRef(commitPinnedOrder);
  commitPinnedOrderRef.current = commitPinnedOrder;

  // Pointer drag reorder: 6px threshold, then targets tiles by [data-pinned-id].
  useEffect(() => {
    if (!onReorder) return;
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
  }, [onReorder]);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 || !onReorder) return;
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false, order: displayPinned.map((a) => a.id) };
  };

  const handleKeyDown = (e: React.KeyboardEvent, id: string) => {
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
  const guardSelect = (agent: T) => () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(agent);
  };

  const tiles = (dragOrder ?? displayPinned.map((a) => a.id))
    .map((id) => agentsById.get(id))
    .filter((a): a is T => Boolean(a));

  if (tiles.length === 0) return null;

  return (
    <div className="grid grid-cols-3 gap-1 py-1">
      {tiles.map((agent) => {
        const selected = selectedId === agent.id;
        const unread = unreadById?.[agent.id]?.count ?? 0;
        const role = tileRole(agent);
        return (
          <button
            key={agent.id}
            type="button"
            data-pinned-id={agent.id}
            aria-current={selected ? 'true' : undefined}
            aria-label={t('Pinned agent {name}. Alt+ArrowUp or Alt+ArrowDown to reorder, drag to reorder.', { name: agent.name })}
            onClick={guardSelect(agent)}
            onContextMenu={(e) => onContextMenu(e, agent)}
            onPointerDown={(e) => handlePointerDown(e, agent.id)}
            onKeyDown={(e) => handleKeyDown(e, agent.id)}
            className={[
              'flex min-w-0 cursor-grab select-none flex-col items-center gap-1 rounded-control px-1 pb-1.5 pt-2 text-center transition-colors active:cursor-grabbing',
              selected ? 'bg-fill-tsp' : 'hover:bg-fill-hover',
            ].join(' ')}
          >
            <span className="relative inline-flex leading-none">
              <AgentAvatar
                name={agent.name}
                avatarShape={agent.avatarShape}
                avatarColor={agent.avatarColor}
                avatarImage={agent.avatarImage}
                size={TILE_AVATAR_SIZE}
              />
              {unread > 0 && (
                <span
                  className="absolute -end-1 -top-1 size-2.5 rounded-full"
                  style={{
                    backgroundColor: 'var(--activity-indicator-running)',
                    boxShadow: '0 0 0 2px var(--background-gray-main)',
                  }}
                  aria-label={t('{count} unread', { count: unread })}
                  title={t('{count} unread', { count: unread })}
                />
              )}
            </span>
            <span className="w-full truncate text-xs font-medium text-text-primary">{agent.name}</span>
            {role ? (
              <span className="w-full truncate text-[10px] leading-tight text-text-tertiary">{role}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
