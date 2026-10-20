'use client';

import { useEffect, useState } from 'react';
import { Wrench, Loader2, AlertCircle } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Section } from './SettingsDialog';

interface Skill {
  name: string;
  description?: string;
}

export function SkillsPane() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/skills`, { headers });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { skills?: Skill[] };
        if (mounted) setSkills(data.skills ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load skills', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="space-y-2">
      <Section title={t('Skills')}>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-1 py-4 text-function-error">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4" />
              <p className="text-sm">{t('Failed to load skills')}</p>
            </div>
            <p className="max-w-[320px] text-xs">{error}</p>
          </div>
        ) : skills.length === 0 ? (
          <p className="py-4 text-sm text-text-tertiary">{t('No skills registered.')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {skills.map((s) => (
              <li key={s.name} className="rounded-card border border-border-main bg-bg-menu p-3">
                <div className="mb-1 flex items-center gap-2">
                  <Wrench className="size-4 text-text-tertiary" />
                  <p className="text-sm font-medium text-text-primary">{s.name}</p>
                </div>
                {s.description && <p className="text-xs text-text-secondary">{s.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
