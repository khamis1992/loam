'use client';

import { useAppSelector } from '@/store';
import { t } from '@/i18n/t';

interface SidePanelProps {
  open: boolean;
}

export function SidePanel({ open }: SidePanelProps) {
  const sessions = useAppSelector((s) => s.sessions.list);
  if (!open) return null;
  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-s border-border-main bg-bg-menu p-3">
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('Recent tasks')}</h3>
      {sessions.length === 0 && <p className="text-xs text-text-tertiary">{t('No content')}</p>}
      <ul className="flex-1 space-y-1 overflow-y-auto">
        {sessions.slice(0, 10).map((s) => (
          <li
            key={s.uid}
            className="truncate rounded-control px-2 py-1 text-xs text-text-secondary hover:bg-fill-hover"
          >
            {s.title || t('New task')}
          </li>
        ))}
      </ul>
      <h3 className="mb-2 mt-3 text-sm font-semibold text-text-primary">{t('Recent files')}</h3>
      <p className="text-xs text-text-tertiary">{t('No content')}</p>
    </aside>
  );
}
