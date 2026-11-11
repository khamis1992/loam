'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { getCompanionDeviceStats, type CompanionDeviceStats } from '@/services/companionsApi';

export function ComputerMetrics({ deviceId }: { deviceId: string }) {
  const [stats, setStats] = useState<CompanionDeviceStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getCompanionDeviceStats(deviceId)
      .then((result) => {
        if (!active) return;
        setStats(result.stats);
        setError(null);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { active = false; };
  }, [deviceId]);

  const memoryUsed = stats?.memoryTotalMB !== undefined && stats.memoryFreeMB !== undefined
    ? stats.memoryTotalMB - stats.memoryFreeMB
    : undefined;
  const memoryPercent = memoryUsed !== undefined && stats?.memoryTotalMB
    ? memoryUsed / stats.memoryTotalMB * 100
    : undefined;

  return (
    <div className="space-y-1.5 border-t border-border-main px-3 py-2 text-[11px]">
      <Metric label="CPU" value={stats?.cpuUtilization !== undefined ? `${stats.cpuUtilization.toFixed(1)}%` : '—'} alert={stats?.cpuUtilization !== undefined && stats.cpuUtilization >= 90} />
      <Metric
        label={t('Memory')}
        value={memoryUsed !== undefined && stats?.memoryTotalMB !== undefined
          ? `${formatGb(memoryUsed)} / ${formatGb(stats.memoryTotalMB)}${memoryPercent !== undefined ? ` · ${memoryPercent.toFixed(0)}%` : ''}`
          : '—'}
        alert={memoryPercent !== undefined && memoryPercent >= 90}
      />
      <Metric
        label={t('Storage')}
        value={stats?.diskUsedGB !== undefined && stats.diskTotalGB !== undefined
          ? `${stats.diskUsedGB} / ${stats.diskTotalGB} GB${stats.diskUsedPercent !== undefined ? ` · ${stats.diskUsedPercent}%` : ''}`
          : '—'}
        alert={stats?.diskUsedPercent !== undefined && stats.diskUsedPercent >= 90}
      />
      {error && <p className="truncate text-func-error" title={error}>{error}</p>}
    </div>
  );
}

function Metric({ label, value, alert }: { label: string; value: string; alert: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-tertiary">{label}</span>
      <span className={alert ? 'text-func-error' : 'text-text-secondary'} dir="ltr">{value}</span>
    </div>
  );
}

function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}
