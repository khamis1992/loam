'use client';

import { t } from '@/i18n/t';
import type { DefensePackage } from '@/services/legalApi';
import { AdversarialFindings } from './AdversarialFindings';

export function DefenseStrategy({ result }: { result: DefensePackage }) {
  const theory = result.theory as unknown as { summary?: string; pleas?: Array<{ id: string; title: string; priority: number }>; weaknesses?: string[] };
  return (
    <div className="space-y-3">
      <section className="rounded-md border p-3"><h3 className="font-semibold">{t('Case theory')}</h3><p>{theory.summary}</p>
        <ol className="mt-2 list-decimal ps-5">{theory.pleas?.map((plea) => <li key={plea.id}>{plea.title}</li>)}</ol>
        {theory.weaknesses && theory.weaknesses.length > 0 && <p className="mt-2 text-amber-700 dark:text-amber-300">{theory.weaknesses.join(' · ')}</p>}
      </section>
      <section className="rounded-md border p-3"><h3 className="font-semibold">{t('Defense memorandum')}</h3><pre className="mt-2 whitespace-pre-wrap font-sans leading-7">{result.draft}</pre></section>
      <AdversarialFindings findings={result.adversarial} />
    </div>
  );
}
