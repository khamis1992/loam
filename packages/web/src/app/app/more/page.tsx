'use client';

import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Settings, HelpCircle, FileText, Bot, Layers, KanbanSquare,
  BookOpen, Brain, Scale, Landmark, Palette, Store, Clapperboard,
} from 'lucide-react';
import { t } from '@/i18n/t';
import { openSettings } from '@/store';
import { useAppDispatch } from '@/store';

export default function MorePage() {
  const router = useRouter();
  const dispatch = useAppDispatch();

  const links = [
    { label: t('Agent Loam'), icon: Bot, href: '/app/agents' },
    { label: t('Creations'), icon: Layers, href: '/app/creations' },
    { label: t('Board'), icon: KanbanSquare, href: '/app/board' },
    { label: t('Wiki'), icon: BookOpen, href: '/app/wiki' },
    { label: t('Memory'), icon: Brain, href: '/app/memory' },
    { label: t('Legal'), icon: Scale, href: '/legal' },
    { label: t('Finance'), icon: Landmark, href: '/app/finance' },
    { label: t('Studio'), icon: Palette, href: '/app/studio' },
    { label: t('Marketplace'), icon: Store, href: '/app/marketplace' },
    { label: t('Video'), icon: Clapperboard, href: '/app/video' },
    { label: t('Settings'), icon: Settings, action: 'settings' },
    { label: t('Docs'), icon: FileText, href: '/app/help' },
    { label: t('Get help'), icon: HelpCircle, href: '/app/help' },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-title-lg text-text-primary">{t('More')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <ul className="flex flex-col gap-1">
          {links.map((link) => (
            <li key={link.label}>
              <button
                type="button"
                onClick={() => {
                  if (link.action === 'settings') dispatch(openSettings('General'));
                  else if (link.href) router.push(link.href);
                }}
                className="flex h-row-sm w-full items-center gap-3 rounded-control px-3 text-sm text-text-primary hover:bg-fill-hover"
              >
                <link.icon className="size-4 text-text-tertiary" />
                {link.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
