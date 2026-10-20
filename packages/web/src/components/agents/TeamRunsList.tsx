'use client';

import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Users } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

interface SwarmRun {
  id: string;
  brief?: string;
  status?: string;
  concurrency?: number;
  createdAt?: string;
}

export function TeamRunsList() {
  const [runs, setRuns] = useState<SwarmRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/swarm/runs`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { runs?: SwarmRun[] };
        if (mounted) setRuns(data.runs ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-text-secondary">
        <Loader2 className="size-5 animate-spin" /> {t('Loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-function-error">
        <AlertCircle className="size-5" />
        <p className="text-sm">{t('Failed to load team runs')}</p>
        <p className="text-center text-xs">{error}</p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-text-tertiary">
        <p className="text-sm">{t('No team runs yet.')}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {runs.map((run) => (
        <div
          key={run.id}
          className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-menu p-3"
        >
          <div className="flex items-center gap-2">
            <Users className="size-4 text-text-secondary" />
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
              {run.brief || run.id}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <span className="rounded-full bg-fill-tsp px-2 py-0.5">{run.status || 'unknown'}</span>
            {typeof run.concurrency === 'number' && (
              <span>{t('Concurrency')}: {run.concurrency}</span>
            )}
          </div>
          {run.createdAt && (
            <p className="text-xs text-text-tertiary">{new Date(run.createdAt).toLocaleString()}</p>
          )}
        </div>
      ))}
    </div>
  );
}
