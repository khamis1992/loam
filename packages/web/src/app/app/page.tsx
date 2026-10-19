'use client';

import { useRouter } from 'next/navigation';
import {
  ChevronDown, Sparkles, PanelRight, Hammer, Pencil, FolderOpen,
} from 'lucide-react';
import { useAppDispatch } from '@/store';
import { addSession } from '@/store/sessionsSlice';
import { t, PRODUCT } from '@/i18n/t';
import { Composer, ComposerContextBar } from '@/components/chat/Composer';
import type { TaskMode } from '@shared/socket';
import { shortUid } from '@/utils/uid';

export default function HomePage() {
  const router = useRouter();
  const dispatch = useAppDispatch();

  const handleSend = (text: string, mode: TaskMode, _files: File[]) => {
    const uid = shortUid();
    dispatch(addSession({
      uid, title: text.slice(0, 60), status: 6, lastMessageTime: Date.now(), lastDisplayMessage: text, icon: '•',
    }));
    router.push(`/app/${uid}/?draft=${encodeURIComponent(text)}&mode=${mode}`);
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {/* Top bar */}
      <div className="flex h-row items-center justify-between px-6">
        <button className="flex items-center gap-1 rounded-control px-2 py-1 text-sm font-medium text-text-primary hover:bg-fill-hover">
          {PRODUCT} 2.0 <ChevronDown className="size-4" />
        </button>
        <div className="flex items-center gap-2">
          <span className="flex h-7 items-center gap-1 rounded-control border border-border-main px-2 text-xs font-medium text-text-secondary">
            <Sparkles className="size-3.5" /> 18.1K
          </span>
          <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover">
            <PanelRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[768px] flex-1 px-6 pb-6">
        {/* Hero */}
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-headline-lg text-text-primary">{PRODUCT.toLowerCase()} studio</h1>
          <div className="flex h-11 w-[200px] items-center gap-2 rounded-control bg-[#1a1a1a] px-3 text-white">
            <div className="size-7 rounded bg-white/10" />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium">Update
              </p>
              <p className="truncate text-[11px] text-[#a3a3a3]">See what's new
              </p>
            </div>
          </div>
        </div>

        {/* Cards grid */}
        <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_216px]">
          <div className="space-y-3">
            <HomeCard icon={<Hammer className="size-5 text-[#0081f2]" />} title={t('Build')} subtitle={t('Websites, apps, and games')} />
            <HomeCard icon={<Pencil className="size-5 text-[#efa201]" />} title={t('Create')} subtitle={t('Slides, images, and videos')} />
          </div>
          <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-[#0081f2] bg-fill-tsp p-4 text-center hover:bg-fill-hover">
            <FolderOpen className="mb-2 size-16 text-text-tertiary" />
            <p className="text-sm font-medium text-text-primary">{t('Start from a local file')}</p>
            <p className="text-xs text-text-tertiary">{t('Click or drag local files here')}</p>
          </div>
        </div>

        {/* Template row */}
        <div className="mb-5 grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-card bg-fill-tsp p-3 text-center hover:bg-fill-hover">
              <div className="mb-2 h-24 rounded bg-fill-hover" />
              <p className="text-[13px] font-medium text-text-primary">Template {i + 1}</p>
            </div>
          ))}
        </div>

        {/* Composer */}
        <div className="mt-auto">
          <ComposerContextBar home />
          <Composer onSend={handleSend} home />
        </div>
      </div>
    </div>
  );
}

function HomeCard({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex h-[104px] items-start justify-between rounded-card bg-fill-tsp p-4 hover:bg-fill-hover">
      <div>
        <div className="mb-2">{icon}</div>
        <p className="text-sm font-semibold text-text-primary">{title} ›</p>
        <p className="text-xs text-text-tertiary">{subtitle}</p>
      </div>
      <div className="h-full w-16 rounded bg-current opacity-10" />
    </div>
  );
}
