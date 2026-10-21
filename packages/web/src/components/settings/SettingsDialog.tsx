'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useAppSelector, useAppDispatch, closeSettings, setSettingsTab } from '@/store';
import { t } from '@/i18n/t';
import { GeneralPane } from './GeneralPane';
import { AccountPane } from './AccountPane';
import { AppearancePane } from './AppearancePane';
import { DataControlsPane } from './DataControlsPane';
import { MyComputerPane } from './MyComputerPane';
import { UsagePane } from './UsagePane';
import { AboutPane } from './AboutPane';
import { ConnectorsPane } from './ConnectorsPane';
import { SkillsPane } from './SkillsPane';
import { MemoryPane } from './MemoryPane';
import { AssetsPane } from './AssetsPane';
import { EmptyState } from './EmptyState';

const TABS = [
  { id: 'General', group: 'Settings', icon: 'SlidersHorizontal' },
  { id: 'Account', group: 'Account', icon: 'User' },
  { id: 'Usage', group: 'Account', icon: 'Sparkles' },
  { id: 'Appearance', group: 'Settings', icon: 'Palette' },
  { id: 'Shortcuts', group: 'Settings', icon: 'Keyboard' },
  { id: 'Data controls', group: 'Data', icon: 'Blocks' },
  { id: 'Personalization', group: 'Capabilities', icon: 'Blocks' },
  { id: 'Connectors', group: 'Capabilities', icon: 'Unplug' },
  { id: 'Skills', group: 'Capabilities', icon: 'Blocks' },
  { id: 'Memory', group: 'Capabilities', icon: 'Database' },
  { id: 'Integrations', group: 'Data', icon: 'Unplug' },
  { id: 'Developers', group: 'Data', icon: 'Blocks' },
  { id: 'My Computer', group: 'Computers', icon: 'Monitor' },
  { id: 'In-App Browser', group: 'Computers', icon: 'Globe' },
  { id: 'Email', group: 'Assets', icon: 'Mail' },
  { id: 'Phone', group: 'Assets', icon: 'Phone' },
  { id: 'Wallet', group: 'Assets', icon: 'Wallet' },
  { id: 'About', group: 'About', icon: 'Info' },
];

const MVP_TAB_IDS = new Set(['General', 'Account', 'Appearance', 'Data controls', 'My Computer', 'Usage', 'About', 'Connectors', 'Skills', 'Memory', 'Email', 'Phone', 'Wallet']);

const GROUP_ORDER = ['Account', 'Settings', 'Capabilities', 'Computers', 'Data', 'Assets', 'About'];

export function SettingsDialog() {
  const open = useAppSelector((s) => s.ui.settingsOpen);
  const activeTab = useAppSelector((s) => s.ui.settingsTab);
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dispatch(closeSettings());
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, dispatch]);
  if (!open) return null;

  const grouped = GROUP_ORDER.map((g) => ({ group: g, tabs: TABS.filter((t) => t.group === g) })).filter((g) => g.tabs.length > 0);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onMouseDown={() => dispatch(closeSettings())}>
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={t('Settings')} tabIndex={-1}
        className="flex h-[756px] w-[1024px] overflow-hidden rounded-[16px] bg-bg-main shadow-menu outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="flex w-[176px] flex-col gap-3 bg-bg-nav p-3" aria-label={t('Settings')}>
          <ProfileHeader />
          <div className="flex h-8 items-center gap-2 rounded-control border border-border-main bg-fill-tsp px-2 text-sm text-text-tertiary">
            <span aria-hidden>🔍</span> {t('Search')}
          </div>
          {grouped.map(({ group, tabs }) => (
            <section key={group}>
              <h3 className="px-2 py-1 text-xs font-medium text-text-tertiary">{t(group)}</h3>
              <ul className="flex flex-col gap-0.5">
                {tabs.map((tab) => (
                  <li key={tab.id}>
                    <button
                      type="button"
                      onClick={() => dispatch(setSettingsTab(tab.id))}
                      aria-current={activeTab === tab.id ? 'page' : undefined}
                      className={clsx(
                        'flex h-[30px] w-full items-center gap-2 rounded-control px-2 text-sm',
                        activeTab === tab.id ? 'bg-fill-tsp text-text-primary' : 'text-text-secondary hover:bg-fill-hover',
                      )}
                    >
                      <span aria-hidden className="text-text-tertiary">{glyphFor(tab.icon)}</span>
                      {t(tab.id)}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <main key={activeTab} className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-headline-sm text-text-primary">{t(activeTab)}</h2>
            <button type="button" aria-label={t('Close')} onClick={() => dispatch(closeSettings())} className="rounded-control p-1 hover:bg-fill-hover text-text-secondary">✕</button>
          </div>
          <hr className="mb-6 border-border-main" />
          <SettingsContent tab={activeTab} />
        </main>
      </div>
    </div>,
    document.body,
  );
}

function ProfileHeader() {
  const user = useAppSelector((s) => s.auth.user);
  const name = user?.displayname || 'Demo User';
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-fill-tsp text-sm">{(name[0] || 'U').toUpperCase()}</div>
      <span className="text-sm font-medium text-text-primary truncate">{name}</span>
    </div>
  );
}

function SettingsContent({ tab }: { tab: string }) {
  if (!MVP_TAB_IDS.has(tab)) {
    return <EmptyState title={t('Coming soon')} />;
  }
  switch (tab) {
    case 'General': return <GeneralPane />;
    case 'Account': return <AccountPane />;
    case 'Appearance': return <AppearancePane />;
    case 'Data controls': return <DataControlsPane />;
    case 'My Computer': return <MyComputerPane />;
    case 'Usage': return <UsagePane />;
    case 'Connectors': return <ConnectorsPane />;
    case 'Skills': return <SkillsPane />;
    case 'Memory': return <MemoryPane />;
    case 'Email': return <AssetsPane kind="Email" />;
    case 'Phone': return <AssetsPane kind="Phone" />;
    case 'Wallet': return <AssetsPane kind="Wallet" />;
    case 'About': return <AboutPane />;
    default: return null;
  }
}

function glyphFor(icon: string) {
  const map: Record<string, string> = {
    SlidersHorizontal: '⚙', User: '👤', Sparkles: '✨', Palette: '🎨', Keyboard: '⌨',
    Blocks: '▦', Unplug: '🔌', Database: '🗄', Monitor: '🖥', Globe: '🌐', Mail: '✉', Phone: '📞',
    Wallet: '👛', Info: 'ℹ',
  };
  return map[icon] || '•';
}

export function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        {description && <span className="text-xs text-text-tertiary">{description}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{title}</h3>
      <div className="divide-y divide-border-main">{children}</div>
    </section>
  );
}
