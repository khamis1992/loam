'use client';

import { useCallback, useEffect, useState } from 'react';
import { Camera, Loader2, Play, Power, RefreshCw, Trash2, UserRoundCheck } from 'lucide-react';
import { t } from '@/i18n/t';
import { Dialog } from '@/components/ui/Dialog';
import {
  getCompanionDevice,
  getCompanionDeviceStats,
  setCompanionControl,
  snapshotCompanionDevice,
  type CompanionDevice,
  type CompanionDeviceDetails,
  type CompanionDeviceStats,
  type DeviceAction,
} from '@/services/companionsApi';

export function ComputerDetailsDialog({ device, open, onClose, onAction, onDelete, busy }: {
  device: CompanionDevice;
  open: boolean;
  onClose: () => void;
  onAction: (id: string, action: DeviceAction) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  busy: boolean;
}) {
  const [details, setDetails] = useState<CompanionDeviceDetails | null>(null);
  const [stats, setStats] = useState<CompanionDeviceStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    if (!open) return;
    const [nextDetails, nextStats] = await Promise.allSettled([getCompanionDevice(device.id), getCompanionDeviceStats(device.id)]);
    if (nextDetails.status === 'rejected') {
      setError(nextDetails.reason instanceof Error ? nextDetails.reason.message : String(nextDetails.reason));
      return;
    }
    setDetails(nextDetails.value);
    setStats(nextStats.status === 'fulfilled' ? nextStats.value.stats : null);
    setError(nextStats.status === 'rejected'
      ? nextStats.reason instanceof Error ? nextStats.reason.message : String(nextStats.reason)
      : null);
  }, [device.id, open]);

  useEffect(() => {
    setDetails(null);
    setStats(null);
    setConfirmDelete(false);
    void refresh();
  }, [refresh]);

  const run = async (operation: () => Promise<unknown>) => {
    setLocalBusy(true);
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLocalBusy(false);
    }
  };

  const working = busy || localBusy;

  return (
    <Dialog open={open} onClose={onClose} title={`${device.name} — ${t('Settings')}`} width={680}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={working} onClick={() => void refresh()} className="flex items-center gap-1.5 rounded-control border border-border-main px-3 py-1.5 text-xs text-text-secondary hover:bg-fill-hover">
            <RefreshCw className="size-3.5" /> {t('Retry')}
          </button>
          {device.state === 'running' && (
            <>
              <button type="button" disabled={working} onClick={() => void onAction(device.id, 'suspend')} className="rounded-control bg-fill-hover px-3 py-1.5 text-xs text-text-primary">{t('Suspend')}</button>
              <button type="button" disabled={working} onClick={() => void onAction(device.id, 'stop')} className="flex items-center gap-1.5 rounded-control bg-fill-hover px-3 py-1.5 text-xs text-text-primary"><Power className="size-3.5" />{t('Stop')}</button>
            </>
          )}
          {(device.state === 'stopped' || device.state === 'error') && (
            <button type="button" disabled={working} onClick={() => void onAction(device.id, 'start')} className="flex items-center gap-1.5 rounded-control bg-fill-hover px-3 py-1.5 text-xs text-text-primary"><Play className="size-3.5" />{t('Start')}</button>
          )}
          {device.state === 'suspended' && (
            <button type="button" disabled={working} onClick={() => void onAction(device.id, 'resume')} className="flex items-center gap-1.5 rounded-control bg-fill-hover px-3 py-1.5 text-xs text-text-primary"><Play className="size-3.5" />{t('Resume')}</button>
          )}
          <button type="button" disabled={working} onClick={() => void run(() => snapshotCompanionDevice(device.id, `Manual ${new Date().toLocaleString()}`))} className="flex items-center gap-1.5 rounded-control border border-border-main px-3 py-1.5 text-xs text-text-secondary hover:bg-fill-hover">
            <Camera className="size-3.5" /> {t('Snapshot')}
          </button>
          <button type="button" disabled={working} onClick={() => void run(() => setCompanionControl(device.id, true))} className="flex items-center gap-1.5 rounded-control border border-border-main px-3 py-1.5 text-xs text-text-secondary hover:bg-fill-hover">
            <UserRoundCheck className="size-3.5" /> {t('Take control')}
          </button>
        </div>

        {error && <p role="alert" className="text-xs text-func-error">{error}</p>}
        {!details ? (
          <div className="flex items-center justify-center py-8 text-text-secondary"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 rounded-card bg-fill-tsp p-4 text-sm md:grid-cols-4">
              <Detail label={t('Status')} value={device.state} />
              <Detail label={t('Ready')} value={details.readiness.ready ? t('Yes') : t('No')} />
              <Detail label={t('Provider')} value={`${device.provider} / ${device.environment}`} />
              <Detail label={t('Template')} value={device.template} />
            </section>
            {stats && (
              <section className="rounded-card border border-border-main p-4">
                <h3 className="mb-2 text-sm font-medium text-text-primary">{t('Resources')}</h3>
                <p className="mb-1 text-xs text-text-secondary">CPU: {stats.cpuUtilization !== undefined ? `${stats.cpuUtilization.toFixed(1)}%` : '—'}</p>
                <p className="text-xs text-text-secondary">
                  {stats.memoryTotalMB !== undefined ? `${Math.round(stats.memoryTotalMB)} MB` : '—'}
                  {stats.memoryFreeMB !== undefined ? ` / ${Math.round(stats.memoryFreeMB)} MB ${t('Free')}` : ''}
                </p>
                {stats.disk && <p className="mt-1 text-xs text-text-tertiary" dir="ltr">{stats.disk}</p>}
              </section>
            )}
            <section>
              <h3 className="mb-2 text-sm font-medium text-text-primary">{t('Activity')}</h3>
              {details.journal.length === 0 ? (
                <p className="text-xs text-text-tertiary">{t('No content')}</p>
              ) : (
                <ul className="max-h-52 space-y-2 overflow-y-auto rounded-card border border-border-main p-3">
                  {details.journal.slice(-10).reverse().map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className="text-xs">
                      <span className={entry.ok ? 'text-func-success' : 'text-func-error'}>●</span>
                      <span className="mx-2 text-text-primary">{entry.event}</span>
                      <time className="text-text-tertiary" dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                      {entry.detail && <p className="mt-0.5 truncate text-text-tertiary" title={entry.detail}>{entry.detail}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <div className="flex justify-end border-t border-border-main pt-3">
          {confirmDelete ? (
            <button type="button" disabled={working} onClick={() => void onDelete(device.id)} className="flex items-center gap-1.5 rounded-control bg-func-error px-3 py-1.5 text-xs font-medium text-white">
              <Trash2 className="size-3.5" /> {t('Confirm delete')}
            </button>
          ) : (
            <button type="button" disabled={working} onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 rounded-control px-3 py-1.5 text-xs text-func-error hover:bg-fill-hover">
              <Trash2 className="size-3.5" /> {t('Delete')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-text-tertiary">{label}</p>
      <p className="truncate text-xs font-medium text-text-primary" title={value}>{value}</p>
    </div>
  );
}
