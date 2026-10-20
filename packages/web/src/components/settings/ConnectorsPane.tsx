'use client';

import { useEffect, useState } from 'react';
import { Puzzle, Loader2, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Section } from './SettingsDialog';

interface Connector {
  name: string;
  connected?: boolean;
  toolCount?: number;
}

export function ConnectorsPane() {
  const [servers, setServers] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/mcp/status`, { headers });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { servers?: Connector[] };
        if (mounted) setServers(data.servers ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load connectors', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="space-y-2">
      <Section title={t('Connectors')}>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-1 py-4 text-function-error">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4" />
              <p className="text-sm">{t('Failed to load connectors')}</p>
            </div>
            <p className="max-w-[320px] text-xs">{error}</p>
          </div>
        ) : servers.length === 0 ? (
          <p className="py-4 text-sm text-text-tertiary">{t('No MCP servers connected.')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {servers.map((s) => (
              <li key={s.name} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                <Puzzle className="size-4 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{s.name}</p>
                  <p className="text-xs text-text-tertiary">{s.toolCount ?? 0} {t('Tools')}</p>
                </div>
                <span className={clsConnected(s.connected)}>
                  {s.connected ? t('Connected') : t('Disconnected')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function clsConnected(connected?: boolean) {
  return `shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${connected ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`;
}
