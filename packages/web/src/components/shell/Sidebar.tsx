import { useMemo } from 'react';
import { useAppSelector, useAppDispatch } from '@/store';
import { selectSession, startNewTask, type AgentSession } from '@/store/sessionsSlice';
import { t } from '@/i18n/t';
import clsx from 'clsx';

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

export function Sidebar() {
  const dispatch = useAppDispatch();
  const { list, activeUid, filter } = useAppSelector((s) => s.sessions);
  const groups = useMemo(() => {
    const visible = filter === 'favorites' ? list.filter((s) => s.isFollowed) : list;
    const map = new Map<string, AgentSession[]>();
    for (const s of visible) {
      const b = bucketOf(s.lastMessageTime ?? 0);
      (map.get(b) ?? map.set(b, []).get(b)!).push(s);
    }
    return BUCKETS.filter((b) => map.has(b)).map((b) => [b, map.get(b)!] as const);
  }, [list, filter]);

  return (
    <nav aria-label="Sidebar" className="flex h-full w-[240px] flex-col bg-bg-nav px-1.5 pb-2 border-e border-border-main">
      <button
        onClick={() => dispatch(startNewTask())}
        className="mt-1 flex h-row items-center gap-2 rounded-row px-2 text-sm text-text-primary hover:bg-fill-hover"
      >
        ＋ {t('New task')}
      </button>
      <input
        placeholder={t('Search tasks...')} aria-label={t('Search')}
        className="mt-1 h-row-sm rounded-control bg-fill-tsp px-2 text-sm placeholder:text-text-tertiary outline-none"
      />
      <div className="mt-3 flex-1 overflow-y-auto">
        {groups.length === 0 && <p className="px-2 text-sm text-text-tertiary">{t('No content')}</p>}
        {groups.map(([bucket, items]) => (
          <section key={bucket} className="mb-2">
            <h3 className="px-2 py-1 text-xs text-text-tertiary">{t(bucket)}</h3>
            {items.map((s) => (
              <SidebarTaskItem key={s.uid} s={s} active={s.uid === activeUid}
                onClick={() => dispatch(selectSession(s.uid))} />
            ))}
          </section>
        ))}
      </div>
    </nav>
  );
}

export function SidebarTaskItem({ s, active, onClick }: { s: AgentSession; active: boolean; onClick: () => void }) {
  const running = s.status === 6;
  return (
    <button
      onClick={onClick} aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex h-row-sm w-full items-center gap-2 rounded-row ps-1.5 pe-0.5 text-start text-sm',
        active ? 'bg-fill-hover text-text-primary' : 'text-text-secondary hover:bg-fill-hover',
      )}
    >
      <span aria-hidden className="w-4 shrink-0 text-center">{s.icon || '•'}</span>
      <span className="flex-1 truncate">{s.title || t('New task')}</span>
      {running && <span className="size-1.5 animate-pulse rounded-full bg-func-success" aria-label={t('Working')} />}
    </button>
  );
}
