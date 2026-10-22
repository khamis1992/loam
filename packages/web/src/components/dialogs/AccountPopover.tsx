'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings, ExternalLink, LogOut, CreditCard, User } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '@/store';
import { openSettings } from '@/store';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { useRouter } from 'next/navigation';
import { logoutAndRedirect } from '@/services/desktopApis';
import { fetchCredits, type CreditPlan } from '@/services/creditsApi';
import { PlanDialog } from './PlanDialog';

export function AccountPopover({ open, onClose, anchor }: { open: boolean; onClose: () => void; anchor?: HTMLElement | null }) {
  const user = useAppSelector((s) => s.auth.user);
  const dispatch = useAppDispatch();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<CreditPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchCredits().then((data) => { if (!cancelled) setPlan(data.plan); }).catch(() => { if (!cancelled) setPlan(null); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && e.target !== anchor) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [open, onClose, anchor]);

  if (!open) return null;
  const name = user?.displayname || 'Demo User';

  const rect = anchor?.getBoundingClientRect();
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.top - 260, left: rect.left, width: 260 }
    : { position: 'fixed', top: '50%', left: '50%', width: 260 };

  const handleSignOut = () => {
    onClose();
    void logoutAndRedirect(router, dispatch);
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t('Account')}
      className="z-50 rounded-card bg-bg-menu p-1.5 shadow-menu outline-none"
      style={style}
    >
      <div className="px-3 py-2" role="none">
        <div className="text-sm font-medium text-text-primary">{name}</div>
        <div className="text-xs text-text-tertiary">{t(plan === 'pro' ? 'Pro plan' : 'Free plan')}</div>
      </div>

      <div className="mb-1 rounded-[10px] bg-fill-tsp p-2" role="none">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text-primary">{t(plan === 'pro' ? 'Pro plan' : 'Free plan')}</span>
          <Button variant="primary" size="sm" onClick={() => { onClose(); setPlanOpen(true); }}>{t('Upgrade')}</Button>
        </div>
      </div>

      <ul className="flex flex-col gap-0.5" role="group" aria-label={t('Account')}>
        <MenuRow icon={<CreditCard className="size-4" />} label={t('Credits ›')} onClick={() => { onClose(); setPlanOpen(true); }} />
        <MenuRow icon={<User className="size-4" />} label={t('Account')} onClick={onClose} />
        <MenuRow
          icon={<Settings className="size-4" />}
          label={t('Settings')}
          onClick={() => { dispatch(openSettings('General')); onClose(); }}
        />
        <MenuRow icon={<ExternalLink className="size-4" />} label={t('Homepage ↗')} onClick={onClose} />
        <MenuRow icon={<ExternalLink className="size-4" />} label={t('Get help ↗')} onClick={onClose} />
        <MenuRow icon={<ExternalLink className="size-4" />} label={t('Docs ↗')} onClick={onClose} />
      </ul>

      <hr className="my-1 border-border-main" role="none" />
      <button
        role="menuitem"
        onClick={handleSignOut}
        className="flex h-row-sm w-full items-center gap-2 px-3 text-sm text-func-error hover:bg-fill-hover rounded-control"
      >
        <LogOut className="size-4" /> {t('Sign out')}
      </button>
      <PlanDialog open={planOpen} onClose={() => setPlanOpen(false)} />
    </div>,
    document.body,
  );
}

function MenuRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <li role="none">
      <button
        role="menuitem"
        onClick={onClick}
        className="flex h-row-sm w-full items-center gap-2 px-3 text-sm text-text-primary hover:bg-fill-hover rounded-control"
      >
        <span className="text-text-tertiary">{icon}</span> {label}
      </button>
    </li>
  );
}
