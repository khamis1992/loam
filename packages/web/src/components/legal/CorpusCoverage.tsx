'use client';

import { t } from '@/i18n/t';
import type { CoverageReport } from '@/services/legalApi';

export function CorpusCoverage({ coverage, snapshotId }: { coverage: CoverageReport; snapshotId?: string }) {
  return (
    <section dir="rtl" className={`space-y-2 rounded-md border p-3 text-xs ${coverage.status === 'complete' ? 'border-emerald-600/40' : 'border-amber-600/50'}`} aria-label={t('Corpus coverage')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{t('Corpus coverage')}</strong>
        <span>{coverage.status === 'complete' ? t('Coverage complete') : coverage.status === 'incomplete' ? t('Coverage incomplete') : t('Coverage not configured')}</span>
      </div>
      {coverage.issues.length > 0 && (
        <ul className="space-y-1">
          {coverage.issues.map((issue) => <li key={`${issue.legKey}:${issue.reason}`}><bdi>{issue.titleAr}</bdi> — {t(issue.reason)}</li>)}
        </ul>
      )}
      {coverage.status !== 'complete' && <p>{t('Required sources need review before final approval.')}</p>}
      {snapshotId && <p dir="ltr" className="opacity-60">{t('Snapshot {id}', { id: snapshotId })}</p>}
    </section>
  );
}
