'use client';

import { useMemo, useState, useEffect, useRef, type ComponentType } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  SquarePen, Monitor, Search, BookOpen, Layers, Workflow, LayoutGrid, MoreHorizontal,
  ChevronRight, Share2, MonitorSmartphone, Clapperboard, Palette, Store, KanbanSquare, Brain,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { useAppSelector, useAppDispatch, toggleSidebar } from '@/store';
import { selectSession, startNewTask, loadSessions, type AgentSession } from '@/store/sessionsSlice';
import { openSettings } from '@/store';
import { t } from '@/i18n/t';
import clsx from 'clsx';
import { fetchCredits, type CreditsReferral } from '@/services/creditsApi';
import { AccountPopover } from '@/components/dialogs/AccountPopover';
import { SearchDialog } from '@/components/dialogs/SearchDialog';
import { ReferralDialog } from '@/components/dialogs/ReferralDialog';
import { NotificationBell } from '@/components/shell/NotificationBell';
import { SidebarTaskItem } from './SidebarTaskItem';

type NavItem = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  href?: string;
  badge?: string;
  shortcut?: string;
  onClick?: string;
};

export function Sidebar() {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const pathname = usePathname();
  const { list, activeUid, filter } = useAppSelector((s) => s.sessions);
  const user = useAppSelector((s) => s.auth.user);
  const [query, setQuery] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [referral, setReferral] = useState<CreditsReferral | null>(null);
  const accountAnchorRef = useRef<HTMLButtonElement>(null);

  // H4: collapsible icon rail — persisted, Ctrl+B, RTL-safe (logical widths).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('loam.sidebar.collapsed') === '1'); } catch { /* default expanded */ }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try { localStorage.setItem('loam.sidebar.collapsed', v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nav: NavItem[] = [
    { id: 'new-task', label: t('New task'), icon: SquarePen, href: '/app' },
    { id: 'computers', label: t('Computers'), icon: Monitor, href: '/app/computers' },
    { id: 'agent-loam', label: t('Agent Loam'), icon: AgentLoamIcon, href: '/app/agents' },
    { id: 'search', label: t('Search'), icon: Search, shortcut: t('Ctrl+K'), onClick: 'search' },
    { id: 'library', label: t('Library'), icon: BookOpen, href: '/app/library' },
    { id: 'creations', label: t('Creations'), icon: Layers, href: '/app/creations' },
    { id: 'board', label: t('Board'), icon: KanbanSquare, href: '/app/board' },
    { id: 'wiki', label: t('Wiki'), icon: BookOpen, href: '/app/wiki' },
    { id: 'memory-hub', label: t('Memory'), icon: Brain, href: '/app/memory' },
    { id: 'studio', label: t('Studio'), icon: Palette, href: '/app/studio' },
    { id: 'automations', label: t('Automations'), icon: Workflow, href: '/app/automations' },
    { id: 'plugins', label: t('Plugins'), icon: LayoutGrid, href: '/app/plugins' },
    { id: 'marketplace', label: t('Marketplace'), icon: Store, href: '/app/marketplace' },
    { id: 'video', label: t('Video'), icon: Clapperboard, href: '/app/video' },
    { id: 'more', label: t('More'), icon: MoreHorizontal, href: '/app/more' },
  ];

  useEffect(() => {
    dispatch(loadSessions());
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;
    fetchCredits()
      .then((data) => { if (!cancelled) setReferral(data.referral); })
      .catch(() => { if (!cancelled) setReferral(null); });
    return () => { cancelled = true; };
  }, []);

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

  const visible = useMemo(() => {
    const base = filter === 'favorites' ? list.filter((s) => s.isFollowed) : list;
    const q = query.trim().toLowerCase();
    return q ? base.filter((s) => (s.title || '').toLowerCase().includes(q)) : base;
  }, [list, filter, query]);

  const name = user?.displayname || 'Demo User';
  const initial = (name[0] || 'U').toUpperCase();

  const navAction = (item: NavItem) => {
    if (item.onClick === 'search') {
      setSearchOpen(true);
    } else if (item.href) {
      router.push(item.href);
    }
  };

  const isNavActive = (item: NavItem) => !!item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <nav
      aria-label={t('Sidebar')}
      data-collapsed={collapsed}
      className={clsx(
        'flex h-full shrink-0 flex-col bg-bg-nav px-2 pb-3 transition-[width] duration-medium ease-loam-in-out',
        collapsed ? 'w-14' : 'w-[192px]',
      )}
    >
      <button
        type="button"
        aria-label={t(collapsed ? 'Expand sidebar' : 'Collapse sidebar')}
        title={t(collapsed ? 'Expand sidebar' : 'Collapse sidebar')}
        data-testid="sidebar-collapse-toggle"
        onClick={toggleCollapsed}
        className="mt-1 flex h-7 w-7 items-center justify-center self-start rounded-control text-text-secondary hover:bg-fill-hover"
      >
        {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
      </button>

      <div className="flex flex-col gap-0.5 py-1.5">
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => navAction(item)}
            title={collapsed ? item.label : undefined}
            className={clsx(
              'group flex h-[26px] w-full items-center gap-2 rounded-[8px] px-2 text-sm',
              collapsed && 'justify-center px-0',
              isNavActive(item) || item.id === 'search'
                ? 'bg-fill-hover text-text-primary'
                : 'text-text-secondary hover:bg-fill-hover',
            )}
            aria-current={isNavActive(item) ? 'page' : undefined}
          >
            {item.id === 'agent-loam' ? (
              <item.icon className="size-4 shrink-0" />
            ) : (
              <item.icon className="size-4 shrink-0" aria-hidden />
            )}
            {!collapsed && <span className="flex-1 truncate text-start">{item.label}</span>}
            {!collapsed && item.badge && (
              <span className="shrink-0 rounded-full bg-fill-tsp px-1.5 py-0 text-[10px] font-medium text-text-tertiary">
                {item.badge}
              </span>
            )}
            {!collapsed && item.shortcut && (
              <span className="shrink-0 text-[11px] text-text-tertiary">{item.shortcut}</span>
            )}
          </button>
        ))}
      </div>

      {!collapsed && (
        <button
          type="button"
          onClick={() => router.push('/app/projects')}
          className="mb-1 flex h-[26px] w-full items-center justify-between rounded-[8px] px-2 text-xs text-text-tertiary hover:bg-fill-hover"
        >
          {t('Projects ›')}
          <ChevronRight className="size-3" aria-hidden />
        </button>
      )}

      {!collapsed && (
        <div className="flex-1 overflow-y-auto">
          <h3 className="px-2 py-1 text-xs text-text-tertiary">{t('Tasks')}</h3>
          {visible.length === 0 && <p className="px-2 text-sm text-text-tertiary">{t('No content')}</p>}
          <ul className="flex flex-col gap-0.5">
            {visible.map((s) => (
              <SidebarTaskItem
                key={s.uid}
                s={s}
                active={s.uid === activeUid}
                onClick={() => { dispatch(selectSession(s.uid)); router.push(`/app/${s.uid}`); }}
              />
            ))}
          </ul>
        </div>
      )}

      <div className={clsx('mt-2 shrink-0 space-y-2', collapsed && 'flex flex-col items-center gap-1')}>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setReferralOpen(true)}
            className="flex w-full items-center gap-2 rounded-card border border-border-main bg-bg-menu px-2.5 py-2 text-start hover:bg-fill-hover"
          >
            <Share2 className="size-4 shrink-0 text-text-secondary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-text-primary">{t('Share Loam with a friend')}</p>
              <p className="truncate text-xs text-text-tertiary">
                {referral ? `${t('Get 500 credits each')} · ${referral.code}` : t('Get 500 credits each')}
              </p>
            </div>
            <ChevronRight className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
          </button>
        )}
        {collapsed && (
          <button
            type="button"
            aria-label={t('Share Loam with a friend')}
            title={t('Share Loam with a friend')}
            onClick={() => setReferralOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover"
          >
            <Share2 className="size-4" aria-hidden />
          </button>
        )}

        <ReferralDialog open={referralOpen} onClose={() => setReferralOpen(false)} />

        <div className={clsx('flex items-center gap-1', collapsed ? 'flex-col' : 'justify-between')}>
          <button
            ref={accountAnchorRef}
            type="button"
            aria-label={collapsed ? name : undefined}
            title={collapsed ? name : undefined}
            onClick={() => setAccountOpen((v) => !v)}
            className="flex flex-1 items-center gap-2 rounded-[8px] px-1.5 py-1 hover:bg-fill-hover"
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-text-primary text-[11px] font-semibold text-text-onblack">
              {initial}
            </div>
            {!collapsed && <span className="flex-1 truncate text-start text-[13px] font-medium text-text-primary">{name}</span>}
          </button>
          <button
            type="button"
            aria-label={t('Devices')}
            title={t('Devices')}
            onClick={() => router.push('/app/computers')}
            className="flex h-7 w-7 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover"
          >
            <MonitorSmartphone className="size-4" />
          </button>
          <NotificationBell />
        </div>
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

function AgentLoamIcon({ className }: { className?: string }) {
  return (
    <div className={clsx('relative flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#0081f2] to-[#64b5f6]', className)}>
      <span className="text-[10px] font-semibold text-white">L</span>
    </div>
  );
}

export { toggleSidebar };
