'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Clock, Zap } from 'lucide-react';
import { t } from '@/i18n/t';
import { getSessionToken, getApiBase } from '@/services/rpc';

interface Schedule {
  id: string;
  name?: string;
  cron?: string;
  enabled?: boolean;
  agentId?: string;
}

export default function AutomationsPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const token = await getSessionToken();
      try {
        const res = await fetch(`${getApiBase()}/api/schedules`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { schedules?: Schedule[] };
        if (mounted) setSchedules(data.schedules ?? []);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('failed to load schedules', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-title-lg text-text-primary">{t('Automations')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No automations yet.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Loam schedules created via the backend will appear here.')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {schedules.map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                {s.cron ? <Clock className="size-4 text-text-tertiary" /> : <Zap className="size-4 text-text-tertiary" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{s.name || s.id}</p>
                  {s.cron && <p className="text-xs text-text-tertiary">{s.cron}</p>}
                </div>
                <span className={clsBadge(s.enabled)}>
                  {s.enabled ? t('Enabled') : t('Disabled')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function clsBadge(enabled?: boolean) {
  return `shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${enabled ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`;
}
