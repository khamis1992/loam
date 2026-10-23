'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { loadMemoryDebug, type MemoryDebugPayload } from '@/services/memoryDebugApi';
import { Section, Row } from './SettingsDialog';

/**
 * Settings > Memory (J6): a local-only debug surface. It shows per-process RSS
 * (desktop main, this renderer, the Loam server process) and one row per
 * bounded in-memory cache with its hard cap and current occupancy.
 *
 * Nothing here is transmitted: the desktop shell answers from the main
 * process's own sampler over IPC, and the browser fallback reads the loopback
 * `/api/debug/memory` route, which is behind the app's local auth token.
 */
export function MemoryDebugPane() {
  const [data, setData] = useState<MemoryDebugPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const next = await loadMemoryDebug();
      setData(next);
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // eslint-disable-next-line no-console
      console.error('failed to load memory debug', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(false), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const caches = data?.caches ?? [];
  const hasCaches = caches.length > 0;

  return (
    <div className="space-y-2">
      <Section title={t('Local memory')}>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-1 py-4 text-function-error">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4" />
              <p className="text-sm">{t('Failed to read memory usage')}</p>
            </div>
            <p className="max-w-[360px] text-xs">{error}</p>
          </div>
        ) : (
          <>
            <Row label={t('Main process')} description={t('Desktop app process (RSS).')}>
              <span className="text-sm text-text-primary">{data?.mainRssMb ?? 0} MB</span>
            </Row>
            <Row
              label={t('Renderer')}
              description={t('This window. The desktop shell reports every open window.')}
            >
              <span className="text-sm text-text-primary">
                {data?.rendererRssMb ?? 0} MB{data?.rendererCount ? ` (${data.rendererCount})` : ''}
              </span>
            </Row>
            <Row label={t('Loam server')} description={t('Node server process running the agent loop.')}>
              <span className="text-sm text-text-primary">
                {data?.serverRssMb ?? 0} MB{data?.serverPid ? ` · pid ${data.serverPid}` : ''}
              </span>
            </Row>
            {data?.system && (
              <Row label={t('System')} description={t('Free memory of this machine.')}>
                <span className="text-sm text-text-primary">
                  {Math.round(data.system.freeBytes / (1024 * 1024 * 1024))} GB / {Math.round(data.system.totalBytes / (1024 * 1024 * 1024))} GB
                </span>
              </Row>
            )}
            <div className="flex justify-end py-2">
              <button
                type="button"
                onClick={() => void load(false)}
                className="flex items-center gap-1 rounded-control border border-border-main px-2 py-1 text-xs text-text-secondary hover:bg-fill-hover"
              >
                <RefreshCw className={clsx('size-3', refreshing && 'animate-spin')} />
                {t('Refresh')}
              </button>
            </div>
          </>
        )}
      </Section>

      <Section title={t('Bounded caches')}>
        {loading ? null : !hasCaches ? (
          <p className="flex items-center gap-2 py-4 text-sm text-text-tertiary">
            <Activity className="size-4" />
            {t('No bounded caches registered yet.')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {caches.map((cache) => {
              const pct = cache.capacity > 0 ? Math.round((cache.size / cache.capacity) * 100) : 0;
              return (
                <li key={cache.name} className="rounded-card border border-border-main bg-bg-menu p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text-primary">{cache.name}</span>
                    <span className="text-[10px] text-text-tertiary">
                      {cache.size}/{cache.capacity} entries
                      {cache.bytes > 0 ? ` · ${Math.round(cache.bytes / 1024)} KB` : ''}
                    </span>
                  </div>
                  <div className="h-1 w-full rounded-full bg-fill-tsp">
                    <div className="h-1 rounded-full bg-fill-hover" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {data?.totals && hasCaches && (
          <p className="pt-2 text-xs text-text-tertiary">
            {data.totals.caches} caches · {data.totals.entries} entries ·{' '}
            {Math.round(data.totals.bytes / 1024)} KB retained
          </p>
        )}
      </Section>
    </div>
  );
}
