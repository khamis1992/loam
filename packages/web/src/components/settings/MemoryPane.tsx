'use client';

import { useEffect, useState } from 'react';
import { Brain, Loader2, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Section, Row } from './SettingsDialog';
import { MemoryDebugPane } from './MemoryDebugPane';
import { WikiSection } from './WikiSection';

interface MemoryEntry {
  id: string;
  text: string;
  kind?: string;
  tags?: string[];
  createdAt?: string;
}

interface MemoryStatus {
  enabled: boolean;
  count: number;
  model?: string;
  file?: string;
  autoStore?: boolean;
}

export function MemoryPane() {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const [statusRes, entriesRes] = await Promise.all([
          fetch(`${getApiBase()}/api/memory/status`, { headers }),
          fetch(`${getApiBase()}/api/memory?limit=50`, { headers }),
        ]);
        if (!statusRes.ok) throw new Error(`status ${statusRes.status}`);
        if (!entriesRes.ok) throw new Error(`entries ${entriesRes.status}`);
        const statusData = (await statusRes.json()) as MemoryStatus;
        const entriesData = (await entriesRes.json()) as { entries?: MemoryEntry[] };
        if (mounted) {
          setStatus(statusData);
          setEntries(entriesData.entries ?? []);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load memory', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="space-y-2">
      <Section title={t('Memory status')}>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-1 py-4 text-function-error">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4" />
              <p className="text-sm">{t('Failed to load memory')}</p>
            </div>
            <p className="max-w-[320px] text-xs">{error}</p>
          </div>
        ) : (
          <>
            <Row label={t('State')} description={t('Whether persistent memory is enabled on this device.')}>
              <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-medium', status?.enabled ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary')}>
                {status?.enabled ? t('Enabled') : t('Disabled')}
              </span>
            </Row>
            <Row label={t('Entries')} description={t('Number of stored memory entries.')}>
              <span className="text-sm text-text-primary">{status?.count ?? 0}</span>
            </Row>
            {status?.model && (
              <Row label={t('Model')} description={t('Embedding model used for memory search.')}>
                <span className="text-sm text-text-primary">{status.model}</span>
              </Row>
            )}
          </>
        )}
      </Section>

      <Section title={t('Entries')}>
        {loading ? null : entries.length === 0 ? (
          <p className="py-4 text-sm text-text-tertiary">{t('No memory entries.')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((e) => (
              <li key={e.id} className="rounded-card border border-border-main bg-bg-menu p-3">
                <div className="mb-1 flex items-center gap-2">
                  <Brain className="size-4 text-text-tertiary" />
                  <span className="text-xs font-medium text-text-secondary">{e.kind ?? 'note'}</span>
                </div>
                <p className="mb-1 text-sm text-text-primary line-clamp-3">{e.text}</p>
                {e.tags && e.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {e.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-fill-tsp px-1.5 py-0.5 text-[10px] text-text-secondary">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <WikiSection />

      <MemoryDebugPane />
    </div>
  );
}
