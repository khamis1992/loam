'use client';

import { useEffect, useRef, useState } from 'react';
import { Gem, Rocket, ExternalLink } from 'lucide-react';
import { useAppDispatch } from '@/store';
import { openSettings } from '@/store';
import { t } from '@/i18n/t';
import { fetchCredits, type CreditPlan } from '@/services/creditsApi';
import { PlanDialog } from '@/components/dialogs/PlanDialog';

export function CreditsPopover({ total }: { total: number }) {
  const [open, setOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState<CreditPlan | null>(null);
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    fetchCredits().then((data) => setPlan(data.plan)).catch(() => setPlan(null));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [open]);

  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(total);
  const full = total.toLocaleString('en');

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-7 items-center gap-1 rounded-control border border-border-main px-2 text-xs font-medium text-text-secondary hover:bg-fill-hover"
      >
        <Gem className="size-3.5" /> {compact}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('Credits')}
          className="absolute right-0 top-full z-50 mt-2 w-[260px] rounded-card bg-bg-menu p-4 shadow-menu outline-none"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-fill-tsp">
              <Gem className="size-4 text-icon-blue" />
            </div>
            <div>
              <div className="text-headline-sm text-text-primary">{full}</div>
              <div className="text-xs text-text-tertiary">{t('Total credits')}{plan ? ` · ${plan === 'pro' ? t('Pro plan') : t('Free plan')}` : ''}</div>
            </div>
          </div>
          <p className="mb-3 text-xs text-text-secondary">{t('Credits available to use across all tasks.')}</p>
          <button
            type="button"
            onClick={() => { setOpen(false); setPlanOpen(true); }}
            className="flex h-row-sm w-full items-center justify-between rounded-control px-2 text-sm text-text-primary hover:bg-fill-hover"
          >
            {t('Plans and credits')}
            <Rocket className="size-3.5 text-text-tertiary" />
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); dispatch(openSettings('Usage')); }}
            className="flex h-row-sm w-full items-center justify-between rounded-control px-2 text-sm text-text-primary hover:bg-fill-hover"
          >
            {t('Usage & Billing')}
            <ExternalLink className="size-3.5 text-text-tertiary" />
          </button>
        </div>
      )}
      <PlanDialog open={planOpen} onClose={() => setPlanOpen(false)} />
    </div>
  );
}
