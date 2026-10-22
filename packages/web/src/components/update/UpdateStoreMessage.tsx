'use client';

import { useEffect } from 'react';
import { useAppSelector, useAppDispatch, setUpdateStatus } from '@/store';
import { t } from '@/i18n/t';
import { desktopApis } from '@/services/desktopApis';

export function UpdateStoreMessage() {
  const status = useAppSelector((s) => s.ui.updateStatus);
  const dispatch = useAppDispatch();

  useEffect(() => {
    desktopApis.updater.getPolicyContext().then((ctx) => {
      if (ctx.storeManaged) {
        dispatch(setUpdateStatus({ state: 'store-managed', store: ctx.platform === 'win32' ? 'Microsoft Store' : ctx.platform === 'darwin' ? 'App Store' : 'Store' }));
      }
    });
  }, [dispatch]);

  if (status.state !== 'store-managed') return null;
  return (
    <div className="rounded-card border border-border-main bg-bg-menu p-4 text-sm text-text-secondary">
      {t('Updates are managed by the app store.', { store: (status as any).store || 'Store' })}
    </div>
  );
}
