'use client';

import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector, setUpdateStatus, type UpdateState } from '@/store';
import { t } from '@/i18n/t';
import { desktopApis, desktopEvents, isDesktop } from '@/services/desktopApis';
import { Row, Section } from '@/components/settings/SettingsDialog';

/** Map an electron-updater status payload (main process) onto the UI state. */
export function mapUpdaterStatus(raw: unknown): { state: UpdateState; upToDate: boolean; disabled: boolean } {
  const s = (raw ?? {}) as { state?: string; version?: string; percent?: number; reason?: string };
  switch (s.state) {
    case 'checking': return { state: { state: 'checking' }, upToDate: false, disabled: false };
    case 'available': return { state: { state: 'available', version: s.version }, upToDate: false, disabled: false };
    case 'downloading': return { state: { state: 'downloading', progress: Math.max(0, Math.min(100, Math.round(s.percent ?? 0))) }, upToDate: false, disabled: false };
    case 'downloaded': return { state: { state: 'downloaded', version: s.version }, upToDate: false, disabled: false };
    case 'installing': return { state: { state: 'restarting' }, upToDate: false, disabled: false };
    case 'error': return { state: { state: 'error', message: s.reason }, upToDate: false, disabled: false };
    case 'current': return { state: { state: 'idle' }, upToDate: true, disabled: false };
    case 'channel-mismatch': return { state: { state: 'error', message: s.state }, upToDate: false, disabled: false };
    case 'disabled': return { state: { state: 'idle' }, upToDate: false, disabled: true };
    default: return { state: { state: 'idle' }, upToDate: false, disabled: false };
  }
}

/**
 * Update button/status (option #10): check, download progress and restart to
 * install, driven by the `updater` IPC namespace through electron-updater.
 * Rendered in Settings › General; desktop builds only.
 */
export function UpdaterSettings() {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.ui.updateStatus);
  const [upToDate, setUpToDate] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [storeManaged, setStoreManaged] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    desktopApis.updater.getPolicyContext().then((ctx) => {
      if (ctx?.storeManaged) setStoreManaged(true);
    }).catch(() => {});
    desktopApis.updater.getStatus().then((raw) => {
      const mapped = mapUpdaterStatus(raw);
      dispatch(setUpdateStatus(mapped.state));
      setUpToDate(mapped.upToDate);
      setDisabled(mapped.disabled);
    }).catch(() => {});
    return desktopEvents.updater.onStatusChanged((raw) => {
      const mapped = mapUpdaterStatus(raw);
      dispatch(setUpdateStatus(mapped.state));
      setUpToDate(mapped.upToDate);
      setDisabled(mapped.disabled);
    });
  }, [dispatch]);

  if (!isDesktop() || storeManaged) return null;

  const check = () => {
    setUpToDate(false);
    dispatch(setUpdateStatus({ state: 'checking' }));
    desktopApis.updater.checkForUpdates();
  };
  const restart = () => {
    dispatch(setUpdateStatus({ state: 'restarting' }));
    desktopApis.updater.restartNow();
  };

  let detail = t('Check for new versions and install them.');
  if (disabled) detail = t('Updates are disabled in unpackaged builds.');
  else if (status.state === 'checking') detail = t('Checking for updates…');
  else if (status.state === 'available') detail = t('Update available: {version}', { version: status.version ?? '' });
  else if (status.state === 'downloading') detail = t('Downloading update… {progress}%', { progress: status.progress });
  else if (status.state === 'downloaded') detail = t('Update downloaded. Restart to install.');
  else if (status.state === 'restarting') detail = t('Restarting…');
  else if (status.state === 'error') detail = t('Update failed: {message}', { message: status.message ?? '' });
  else if (upToDate) detail = t("You're up to date");

  return (
    <Section title={t('Updates')}>
      <Row label={t('Updates')} description={detail}>
        {status.state === 'downloaded' ? (
          <button
            type="button"
            onClick={restart}
            className="h-row-sm rounded-control bg-text-primary px-3 text-sm text-text-onblack hover:opacity-90"
          >
            {t('Restart to update')}
          </button>
        ) : (
          <button
            type="button"
            onClick={check}
            disabled={disabled || status.state === 'checking' || status.state === 'downloading' || status.state === 'restarting'}
            className="h-row-sm rounded-control border border-border-main px-3 text-sm text-text-primary hover:bg-fill-hover disabled:opacity-40"
          >
            {t('Check for updates')}
          </button>
        )}
      </Row>
      {status.state === 'downloading' && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-fill-tsp">
          <div className="h-full rounded-full bg-icon-blue transition-all" style={{ width: `${status.progress}%` }} />
        </div>
      )}
    </Section>
  );
}
