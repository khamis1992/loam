'use client';

import { t } from '@/i18n/t';
import type { StructureIssue, VerificationReport } from '@/services/legalApi';
import { CitationBadge, badgeStateFor } from './CitationBadge';

const VERDICT: Record<VerificationReport['verdict'], { cls: string; label: string }> = {
  pass: { cls: 'border-emerald-600/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100', label: 'All citations verified' },
  pass_with_warnings: { cls: 'border-amber-600/40 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100', label: 'Verified with warnings' },
  fail: { cls: 'border-red-600/50 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100', label: 'Verification failed: the draft cannot be exported' },
};

export function VerificationReportView({ report, structure = [], lang = 'ar' }: { report: VerificationReport; structure?: StructureIssue[]; lang?: 'ar' | 'en' }) {
  const v = VERDICT[report.verdict];
  const problems = report.checks.filter((c) => c.status !== 'OK' && c.status !== 'VERIFIED' && c.status !== 'VERIFIED_NORMALIZED');
  const warnCodes = (avid: string | null) => report.warnings.filter((w) => w.avid && w.avid === avid).map((w) => w.code);
  return (
    <section dir={lang === 'ar' ? 'rtl' : 'ltr'} className="space-y-3 text-sm" aria-live="polite">
      <div role="status" className={`rounded-lg border p-3 font-medium ${v.cls}`}>
        {t(v.label)}
        <div className="mt-1 text-xs font-normal opacity-80">
          {t('As of {date}', { date: report.asOf })} · {t('{n} cited', { n: report.counts.cited })} · {t('{n} verified', { n: report.counts.verified })} ·{' '}
          {t('{n} failed', { n: report.counts.failed })} · {t('{n} need lawyer research', { n: report.counts.unverifiedMarkers })}
        </div>
      </div>
      {problems.length > 0 && (
        <div>
          <h4 className="mb-1 font-semibold">{t('Problems')}</h4>
          <ul className="space-y-1">
            {problems.map((c) => (
              <li key={`${c.index}-${c.span.start}`} className="flex flex-wrap items-start gap-2">
                <CitationBadge state={badgeStateFor(c.status)} title={c.status} />
                <span dir="auto">{lang === 'ar' ? c.messageAr : c.messageEn}</span>
                {c.quote ? <q dir="auto" className="block w-full truncate opacity-70">{c.quote}</q> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.checks.some((c) => c.status === 'VERIFIED' || c.status === 'VERIFIED_NORMALIZED') && (
        <div>
          <h4 className="mb-1 font-semibold">{t('Verified citations')}</h4>
          <ul className="space-y-1">
            {report.checks.filter((c) => c.status === 'VERIFIED' || c.status === 'VERIFIED_NORMALIZED').map((c) => (
              <li key={`${c.index}-${c.span.start}`}>
                <CitationBadge state={badgeStateFor(c.status, warnCodes(c.avid))} {...(c.rendered ? { reference: c.rendered } : {})} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.warnings.length > 0 && (
        <div>
          <h4 className="mb-1 font-semibold">{t('Warnings')}</h4>
          <ul className="list-disc space-y-1 ps-5">
            {report.warnings.map((w, i) => <li key={`${w.code}-${i}`} dir="auto">{lang === 'ar' ? w.messageAr : w.messageEn}</li>)}
          </ul>
        </div>
      )}
      {structure.length > 0 && (
        <div>
          <h4 className="mb-1 font-semibold">{t('Document structure')}</h4>
          <ul className="list-disc space-y-1 ps-5">
            {structure.map((s, i) => <li key={`${s.code}-${i}`} className={s.level === 'error' ? 'text-red-700 dark:text-red-300' : ''} dir="auto">{s.messageAr}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
