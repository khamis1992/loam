'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector, useAppDispatch, setUpdateStatus, type UpdateState } from '@/store';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { desktopApis } from '@/services/desktopApis';

export function UpdatePopover({ anchor }: { anchor?: HTMLElement | null }) {
  const status = useAppSelector((s) => s.ui.updateStatus);
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!status || status.state === 'idle' || status.state === 'store-managed') return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && e.target !== anchor) {
        dispatch(setUpdateStatus({ state: 'idle' }));
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [status, anchor, dispatch]);

  if (!status || status.state === 'idle' || status.state === 'store-managed') return null;

  const rect = anchor?.getBoundingClientRect();
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.bottom + 8, right: window.innerWidth - rect.right, width: 320 }
    : { position: 'fixed', top: 48, right: 16, width: 320 };

  return createPortal(
    <div ref={ref} className="z-50 rounded-card bg-bg-menu p-4 shadow-menu" style={style}>
      <UpdateContent status={status} />
    </div>,
    document.body,
  );
}

function UpdateContent({ status }: { status: UpdateState }) {
  const dispatch = useAppDispatch();
  switch (status.state) {
    case 'checking':
      return (
        <div className="flex items-center gap-2 text-sm text-text-primary">
          <Spinner /> {t('Checking for updates…')}
        </div>
      );
    case 'available':
      return (
        <div className="space-y-3">
          <div className="text-sm font-medium text-text-primary">{t('Important update available')}</div>
          <Button
            variant="primary" size="sm" className="w-full"
            onClick={() => { desktopApis.updater.checkForUpdates(); dispatch(setUpdateStatus({ state: 'downloading', progress: 0 })); }}
          >
            {t('Update now')}
          </Button>
        </div>
      );
    case 'downloading':
      return (
        <div className="space-y-2">
          <div className="text-sm text-text-primary">{t('Preparing update… {progress}%', { progress: status.progress })}</div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-fill-tsp">
            <div className="h-full rounded-full bg-icon-blue transition-all" style={{ width: `${status.progress}%` }} />
          </div>
        </div>
      );
    case 'downloaded':
      return (
        <div className="space-y-3">
          <div className="text-sm text-text-primary">{t('Version {version} or later', { version: status.version || '' })}</div>
          <Button
            variant="primary" size="sm" className="w-full"
            onClick={() => { dispatch(setUpdateStatus({ state: 'restarting' })); desktopApis.updater.restartNow(); }}
          >
            {t('Restart and update')}
          </Button>
        </div>
      );
    case 'restarting':
      return (
        <div className="flex items-center gap-2 text-sm text-text-primary">
          <Spinner /> {t('Restarting…')}
        </div>
      );
    case 'error':
      return (
        <div className="space-y-3">
          <div className="text-sm text-func-error">{t('Unable to update. Please try again.')}</div>
          <Button
            variant="secondary" size="sm" className="w-full"
            onClick={() => { dispatch(setUpdateStatus({ state: 'checking' })); desktopApis.updater.checkForUpdates(); }}
          >
            {t('Retry')}
          </Button>
        </div>
      );
    default:
      return null;
  }
}

function Spinner() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
