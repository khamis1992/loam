'use client';

import { t } from '@/i18n/t';
import type { EvidenceDocument } from '@/services/legalApi';

export function DocumentViewer({ document }: { document?: EvidenceDocument }) {
  if (!document) return <p className="text-sm opacity-70">{t('Select a document to preview')}</p>;
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">{document.fileName}</h3>
      <div className="max-h-[60vh] overflow-auto rounded-md border p-3">
        {document.pages.map((page) => (
          <article key={page.page} className="mb-3 border-b pb-3 last:border-0">
            <h4 dir="ltr" className="text-xs opacity-60">{t('Page {n}', { n: page.page })}</h4>
            <p className="whitespace-pre-wrap leading-7">{page.text || t('No text available')}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
