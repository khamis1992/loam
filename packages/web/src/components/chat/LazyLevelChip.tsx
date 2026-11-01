'use client';

import { useEffect, useState } from 'react';
import { t, getLocale } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

const LEVELS = ['off', 'lite', 'full', 'ultra'] as const;
type Level = (typeof LEVELS)[number];

const AR_LABEL: Record<Level, string> = { off: 'إيقاف', lite: 'مختصر', full: 'كامل', ultra: 'أقصى' };

/** lazy-senior (Ponytail BUILD_SPEC P2): the active coding-discipline level
 *  shown as plain text next to the mode chip in build mode — no icon. It
 *  reads the durable setting; a /lazy session override is announced in chat
 *  and lasts for that session. Hidden outside build mode. */
export function LazyLevelChip({ modeId }: { modeId?: string }) {
  const [level, setLevel] = useState<Level | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${getApiBase()}/api/settings`, { headers: await getApiHeaders() });
        if (!response.ok) return;
        const body = (await response.json()) as { codingDiscipline?: string };
        if (!cancelled && (LEVELS as readonly string[]).includes(body.codingDiscipline ?? '')) {
          setLevel(body.codingDiscipline as Level);
        }
      } catch {
        /* the chip stays hidden when settings are unreachable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!level || (modeId && modeId !== 'build')) return null;
  const label = getLocale() === 'ar' ? AR_LABEL[level] : level;
  return (
    <span className="hidden text-xs text-text-secondary sm:inline" title={t('Coding discipline')}>
      {t('Discipline')}: {label} ({level})
    </span>
  );
}
