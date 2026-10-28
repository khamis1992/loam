'use client';

import { t } from '@/i18n/t';

export function AdversarialFindings({ findings }: { findings: Array<{ severity: string; code: string; message: string }> }) {
  if (findings.length === 0) return <p className="rounded-md border border-emerald-600/40 p-3 text-sm">{t('No adversarial findings')}</p>;
  return (
    <section>
      <h3 className="mb-2 font-semibold">{t('Adversarial review')}</h3>
      <ul className="space-y-2">
        {findings.map((finding, index) => (
          <li key={`${finding.code}:${index}`} className={`rounded-md border p-3 text-sm ${finding.severity === 'critical' ? 'border-red-600/60' : 'border-amber-600/50'}`}>
            <strong dir="ltr">{finding.severity} · {finding.code}</strong>
            <p>{finding.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
