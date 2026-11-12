'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import clsx from 'clsx';
import { useAppDispatch, useAppSelector, setUpdateStatus } from '@/store';
import { t } from '@/i18n/t';
import { desktopApis, desktopEvents, isDesktop } from '@/services/desktopApis';
import { mapUpdaterStatus } from './UpdaterSettings';

/**
 * Sidebar update control for the installed desktop app, shown while an update
 * check or installation needs attention. Settings offers the same actions.
 */
export function UpdateButton({ collapsed = false }: { collapsed?: boolean }) {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.ui.updateStatus);
  const [upToDate, setUpToDate] = useState(false);
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancel = false;
    const apply = (raw: unknown) => {
      if (cancel || raw == null) return;
      const mapped = mapUpdaterStatus(raw);
      dispatch(setUpdateStatus(mapped.state));
      setUpToDate(mapped.upToDate);
      setDisabled(mapped.disabled);
    };
    desktopApis.updater.getStatus().then(apply).catch(() => {});
    const unsubscribe = desktopEvents.updater.onStatusChanged(apply);
    return () => {
      cancel = true;
      unsubscribe();
    };
  }, [dispatch]);

  if (!isDesktop() || upToDate) return null;

  const busy = status.state === 'checking' || status.state === 'downloading' || status.state === 'restarting';
  const downloaded = status.state === 'downloaded';

  const onClick = () => {
    if (downloaded) {
      dispatch(setUpdateStatus({ state: 'restarting' }));
      void desktopApis.updater.restartNow();
      return;
    }
    setUpToDate(false);
    dispatch(setUpdateStatus({ state: 'checking' }));
    void desktopApis.updater.checkForUpdates().then((raw) => {
      if (raw == null) return;
      const mapped = mapUpdaterStatus(raw);
      dispatch(setUpdateStatus(mapped.state));
      setUpToDate(mapped.upToDate);
      setDisabled(mapped.disabled);
    }).catch(() => {
      dispatch(setUpdateStatus({ state: 'error' }));
    });
  };

  let label = t('Check for updates');
  if (disabled) label = t('Updates are disabled in unpackaged builds.');
  else if (status.state === 'checking') label = t('Checking for updates…');
  else if (status.state === 'available') label = t('Update now');
  else if (status.state === 'downloading') label = t('Downloading update… {progress}%', { progress: status.progress });
  else if (downloaded) label = t('Restart to update');
  else if (status.state === 'restarting') label = t('Restarting…');
  else if (status.state === 'error') label = t('Unable to update. Please try again.');
  else if (upToDate) label = t("You're up to date");

  const hint = disabled
    ? label
    : upToDate
      ? t('Raise the version and build again. This button installs the new build.')
      : status.state === 'error' && status.message
        ? t('Update failed: {message}', { message: status.message })
        : label;

  return (
    <button
      type="button"
      data-testid="app-update-button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-label={label}
      className={clsx(
        'flex items-center gap-2 rounded-card border border-border-main bg-bg-menu text-start hover:bg-fill-hover disabled:opacity-60',
        collapsed ? 'h-8 w-8 justify-center px-0' : 'w-full px-2.5 py-2',
      )}
    >
      <Download className="size-4 shrink-0 text-text-secondary" aria-hidden />
      {!collapsed && <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{label}</span>}
    </button>
  );
}
