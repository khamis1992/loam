'use client';

import { CheckCircle2, Download, LogIn, MonitorCheck, Plus } from 'lucide-react';
import { t } from '@/i18n/t';
import { Dialog } from '@/components/ui/Dialog';

export function ConnectComputerDialog({ open, onClose, onOpenDevices, onNewCompanion }: {
  open: boolean;
  onClose: () => void;
  onOpenDevices: () => void;
  onNewCompanion: () => void;
}) {
  const steps = [
    { title: t('Install {product} Desktop', { product: 'Loam' }), description: t('On the computer you want to connect.'), Icon: Download },
    { title: t('Sign in to your account'), description: t('Use the same account you’re using here.'), Icon: LogIn },
    { title: t('Keep the desktop app open'), description: t('Your computer will appear here automatically.'), Icon: MonitorCheck },
  ];
  return (
    <Dialog open={open} onClose={onClose} title={t('Connect new computer')} width={520}>
      <ol className="space-y-5">
        {steps.map(({ title, description, Icon }, index) => (
          <li key={title} className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fill-tsp text-xs font-medium text-text-secondary">{index + 1}</span>
            <div className="min-w-0 space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium leading-6 text-text-primary"><Icon className="size-4 text-text-tertiary" />{title}</p>
              <p className="text-[13px] leading-5 text-text-secondary">{description}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex items-start gap-2 rounded-xl bg-fill-tsp p-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-text-secondary" />
        <p className="text-[13px] leading-5 text-text-secondary">{t('When you start remote control, approve access on that computer.')}</p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onNewCompanion} className="flex items-center gap-1.5 rounded-control border border-border-main px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover">
          <Plus className="size-4" /> {t('New companion')}
        </button>
        <button type="button" onClick={onOpenDevices} className="rounded-control bg-[#1a1a19] px-3 py-1.5 text-sm font-medium text-white dark:bg-white/90 dark:text-black">
          {t('Open devices')}
        </button>
      </div>
    </Dialog>
  );
}
