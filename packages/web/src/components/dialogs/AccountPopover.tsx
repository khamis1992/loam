'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings, ExternalLink, LogOut, CreditCard, User } from 'lucide-react';
import { useAppSelector, useAppDispatch, logout } from '@/store';
import { openSettings } from '@/store';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';

export function AccountPopover({ open, onClose, anchor }: { open: boolean; onClose: () => void; anchor?: HTMLElement | null }) {
  const user = useAppSelector((s) => s.auth.user);
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLDivElement>(null);

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
    (window as any).__apis?.auth?.removeToken?.();
    dispatch(logout());
    onClose();
    window.location.href = '/login';
  };

  return createPortal(
    <div
      ref={ref}
      className="z-50 rounded-card bg-bg-menu p-1.5 shadow-menu outline-none"
      style={style}
    >
      <div className="px-3 py-2">
        <div className="text-sm font-medium text-text-primary">{name}</div>
        <div className="text-xs text-text-tertiary">{t('Free plan')}</div>
      </div>

      <div className="mb-1 rounded-[10px] bg-fill-tsp p-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text-primary">{t('Free plan')}</span>
          <Button variant="primary" size="sm">{t('Upgrade')}</Button>
        </div>
      </div>

      <ul className="flex flex-col gap-0.5">
        <MenuRow icon={<CreditCard className="size-4" />} label={t('Credits ›')} onClick={onClose} />
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

      <hr className="my-1 border-border-main" />
      <button
        onClick={handleSignOut}
        className="flex h-row-sm w-full items-center gap-2 px-3 text-sm text-func-error hover:bg-fill-hover rounded-control"
      >
        <LogOut className="size-4" /> {t('Sign out')}
      </button>
    </div>,
    document.body,
  );
}

function MenuRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-row-sm w-full items-center gap-2 px-3 text-sm text-text-primary hover:bg-fill-hover rounded-control"
    >
      <span className="text-text-tertiary">{icon}</span> {label}
    </button>
  );
}
