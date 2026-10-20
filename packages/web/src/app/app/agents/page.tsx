'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, ArrowLeft, Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { getSessionToken, getApiBase } from '@/services/rpc';

interface Agent {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  mode?: string;
  workMode?: string;
  archivedAt?: string;
}

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const token = await getSessionToken();
      try {
        const res = await fetch(`${getApiBase()}/api/agents`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { agents?: Agent[] };
        if (mounted) setAgents((data.agents ?? []).filter((a) => !a.archivedAt));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('failed to load agents', e);
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
        <h1 className="text-title-lg text-text-primary">{t('Agent Loam')}</h1>

      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No agents yet.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Create companions from the backend console; they will appear here.')}</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-3 rounded-card border border-border-main bg-bg-menu p-3 hover:bg-fill-hover"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fill-tsp text-lg">
                  {a.emoji || '🤖'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{a.name}</p>
                  {a.description && (
                    <p className="line-clamp-2 text-xs text-text-tertiary">{a.description}</p>
                  )}
                  <p className="mt-1 text-[11px] text-text-tertiary">
                    {a.workMode || a.mode || 'loam'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
