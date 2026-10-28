'use client';

import { t } from '@/i18n/t';
import type { DocumentAnalysisReport } from '@/services/legalApi';
import { CorpusCoverage } from './CorpusCoverage';

export function DocumentAnalysisView({ report }: { report: DocumentAnalysisReport }) {
  return (
    <div className="space-y-3">
      <section className="rounded-md border p-3"><h3 className="font-semibold">{t('Executive summary')}</h3><p className="mt-1 leading-7">{report.summary}</p></section>
      <CorpusCoverage coverage={report.coverage} snapshotId={report.corpusSnapshotId} />
      <section>
        <h3 className="mb-2 font-semibold">{t('Risks and missing information')}</h3>
        <ul className="space-y-2">
          {[...report.risks, ...report.missingInformation].map((item) => <li key={item.id} className="rounded-md border p-3"><strong>{item.title}</strong><p>{item.details}</p><span dir="ltr" className="text-xs opacity-60">{item.severity}</span></li>)}
        </ul>
      </section>
      <section><h3 className="font-semibold">{t('Questions')}</h3><ul className="list-disc ps-5">{report.questions.map((item, index) => <li key={index}>{item.question}</li>)}</ul></section>
    </div>
  );
}
