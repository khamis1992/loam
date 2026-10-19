'use client';

import { useMemo } from 'react';
import {
  Blocks,
  Ellipsis,
  FolderPlus,
  LibraryBig,
  Monitor,
  Search,
  Shapes,
  SquarePen,
  Workflow,
} from 'lucide-react';
import clsx from 'clsx';
import { useAppSelector, useAppDispatch } from '@/store';
import { selectSession, startNewTask } from '@/store/sessionsSlice';
import { SidebarTaskItem } from './SidebarTaskItem';

const BUCKETS = ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Older'] as const;

export function bucketOf(ms: number, now = Date.now()): (typeof BUCKETS)[number] {
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ms >= +startOfToday) return 'Today';
  if (ms >= +startOfToday - day) return 'Yesterday';
  if (ms >= +startOfToday - 7 * day) return 'Last 7 days';
  if (ms >= +startOfToday - 30 * day) return 'Last 30 days';
  return 'Older';
}

function NavRow({
  icon, label, active, onClick, shortcut,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  shortcut?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex h-row-sm w-full items-center gap-2 rounded-row px-1.5 text-start text-sm transition-colors',
        active ? 'bg-fill-hover text-text-primary' : 'text-text-secondary hover:bg-fill-hover hover:text-text-primary',
      )}
    >
      <span className="flex size-5 items-center justify-center" aria-hidden>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <span className="ms-auto text-xs text-text-tertiary">{shortcut}</span>}
    </button>
  );
}

export function Sidebar() {
  const dispatch = useAppDispatch();
  const { list, activeUid } = useAppSelector((s) => s.sessions);
  const groups = useMemo(() => {
    const map = new Map<string, typeof list>();
    for (const s of list) {
      const b = bucketOf(s.lastMessageTime);
      (map.get(b) ?? map.set(b, []).get(b)!).push(s);
    }
    return BUCKETS.filter((b) => map.has(b)).map((b) => [b, map.get(b)!] as const);
  }, [list]);

  return (
    <nav
      aria-label="Sidebar"
      className="flex h-full w-[240px] shrink-0 flex-col border-e border-border-main bg-bg-nav px-2 pb-2"
    >
      <div className="flex flex-col gap-0.5 py-2">
        <NavRow
          icon={<SquarePen size={16} strokeWidth={1.75} />}
          label="New task"
          shortcut="Ctrl+⇧+O"
          active={activeUid === null}
          onClick={() => dispatch(startNewTask())}
        />
        <NavRow icon={<Monitor size={16} strokeWidth={1.75} />} label="Computers" />
        <NavRow
          icon={<span className="flex size-4 items-center justify-center rounded-full bg-[#0081f2] text-[10px] text-white">◉</span>}
          label={<span className="flex items-center gap-2">
            Agents
            <span className="rounded-full bg-fill-tsp-white-dark px-1.5 text-[11px] font-semibold">Cue!</span>
          </span>}
        />
        <NavRow icon={<Search size={16} strokeWidth={1.75} />} label="Search" />
        <NavRow icon={<LibraryBig size={16} strokeWidth={1.75} />} label="Library" />
        <NavRow icon={<Shapes size={16} strokeWidth={1.75} />} label="Creations" />
        <NavRow icon={<Workflow size={16} strokeWidth={1.75} />} label="Automations" />
        <NavRow icon={<Blocks size={16} strokeWidth={1.75} />} label="Plugins" />
        <NavRow icon={<Ellipsis size={16} strokeWidth={1.75} />} label="More" />
      </div>

      <div className="flex flex-col gap-0.5">
        <div className="flex h-row items-center px-2 text-xs font-medium text-text-tertiary">Projects</div>
        <NavRow icon={<FolderPlus size={16} strokeWidth={1.75} />} label="New project" />
      </div>

      <div className="mt-2 flex flex-1 flex-col gap-0.5 overflow-y-auto">
        <div className="flex h-row items-center px-2 text-xs font-medium text-text-tertiary">Tasks</div>
        {groups.length === 0 && (
          <p className="px-2 text-sm text-text-tertiary">No content</p>
        )}
        {groups.map(([bucket, items]) => (
          <section key={bucket} className="mb-2">
            <h3 className="px-2 py-1 text-xs text-text-tertiary">{bucket}</h3>
            {items.map((s) => (
              <SidebarTaskItem
                key={s.uid}
                s={s}
                active={s.uid === activeUid}
                onClick={() => dispatch(selectSession(s.uid))}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="mt-auto flex h-12 items-center gap-2 border-t border-border-main px-2">
        <div className="size-6 rounded-full bg-fill-tsp-white-dark" />
        <span className="flex-1 truncate text-sm text-text-primary">User</span>
      </div>
    </nav>
  );
}
