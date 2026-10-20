'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Settings, LogOut } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '@/store';
import { selectSession, startNewTask, loadSessions, type AgentSession } from '@/store/sessionsSlice';
import { openSettings, logout } from '@/store';
import { t } from '@/i18n/t';
import clsx from 'clsx';
import { AccountPopover } from '@/components/dialogs/AccountPopover';
import { SearchDialog } from '@/components/dialogs/SearchDialog';
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

export function Sidebar() {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const { list, activeUid, filter } = useAppSelector((s) => s.sessions);
  const user = useAppSelector((s) => s.auth.user);
  const [query, setQuery] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const accountAnchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dispatch(loadSessions());
  }, [dispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const groups = useMemo(() => {
    const base = filter === 'favorites' ? list.filter((s) => s.isFollowed) : list;
    const q = query.trim().toLowerCase();
    const visible = q ? base.filter((s) => (s.title || '').toLowerCase().includes(q)) : base;
    const map = new Map<string, AgentSession[]>();
    for (const s of visible) {
      const b = bucketOf(s.lastMessageTime ?? 0);
      (map.get(b) ?? map.set(b, []).get(b)!).push(s);
    }
    return BUCKETS.filter((b) => map.has(b)).map((b) => [b, map.get(b)!] as const);
  }, [list, filter, query]);

  const name = user?.displayname || 'Demo User';

  return (
    <nav aria-label="Sidebar" className="flex h-full w-[240px] flex-col bg-bg-nav px-1.5 pb-2 border-e border-border-main">
      <button
        onClick={() => dispatch(startNewTask())}
        className="mt-1 flex h-row items-center gap-2 rounded-row px-2 text-sm text-text-primary hover:bg-fill-hover"
      >
        ＋ {t('New task')}
      </button>

      <div className="mt-1 flex h-row-sm items-center gap-2 rounded-control bg-fill-tsp px-2">
        <Search className="size-4 text-text-tertiary" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search tasks...')}
          aria-label={t('Search')}
          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
        />
        <kbd className="hidden rounded px-1 text-[11px] text-text-tertiary border border-border-main sm:inline">Ctrl K</kbd>
      </div>

      <div className="mt-3 flex-1 overflow-y-auto">
        {groups.length === 0 && <p className="px-2 text-sm text-text-tertiary">{t('No content')}</p>}
        {groups.map(([bucket, items]) => (
          <section key={bucket} className="mb-2">
            <h3 className="px-2 py-1 text-xs text-text-tertiary">{t(bucket)}</h3>
            {items.map((s) => (
              <SidebarTaskItem
                key={s.uid}
                s={s}
                active={s.uid === activeUid}
                onClick={() => { dispatch(selectSession(s.uid)); router.push(`/app/${s.uid}`); }}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between gap-1 border-t border-border-main pt-2">
        <button
          ref={accountAnchorRef}
          onClick={() => setAccountOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 rounded-row px-1.5 py-1 hover:bg-fill-hover"
        >
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-fill-tsp text-xs text-text-primary">
            {(name[0] || 'U').toUpperCase()}
          </div>
          <span className="flex-1 truncate text-left text-sm text-text-primary">{name}</span>
        </button>
        <button
          aria-label={t('Settings')}
          onClick={() => dispatch(openSettings('General'))}
          className="flex h-7 w-7 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover"
        >
          <Settings className="size-4" />
        </button>
        <button
          aria-label={t('Sign out')}
          onClick={() => {
            (window as any).__apis?.auth?.removeToken?.();
            dispatch(logout());
            window.location.href = '/login';
          }}
          className="flex h-7 w-7 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover"
        >
          <LogOut className="size-4" />
        </button>
      </div>

      <AccountPopover
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        anchor={accountAnchorRef.current}
      />
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </nav>
  );
}
