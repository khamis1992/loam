'use client';

import { t } from '@/i18n/t';
import type { LegalResponsePackage } from '@/services/legalApi';

export function ResponseMatrix({ result }: { result: LegalResponsePackage }) {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead><tr><th className="p-2 text-start">{t('Allegation')}</th><th className="p-2 text-start">{t('Disposition')}</th><th className="p-2 text-start">{t('Response')}</th><th className="p-2 text-start">{t('Decision required')}</th></tr></thead>
          <tbody>{result.matrix.entries.map((entry) => <tr key={entry.id} className="border-t"><td className="p-2">{entry.allegation}</td><td className="p-2">{t(entry.disposition)}</td><td className="p-2">{entry.response}</td><td className="p-2">{entry.needsClientDecision ? t('Yes') : t('No')}</td></tr>)}</tbody>
        </table>
      </div>
      <section className="rounded-md border p-3"><h3 className="font-semibold">{t('Legal response')}</h3><pre className="mt-2 whitespace-pre-wrap font-sans leading-7">{result.draft}</pre></section>
    </div>
  );
}
