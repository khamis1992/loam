'use client';

import { t } from '@/i18n/t';
import type { EvidenceAnchor, EvidenceDocument } from '@/services/legalApi';

export function SourceInspector({ document, anchor }: { document?: EvidenceDocument; anchor: EvidenceAnchor | null }) {
  return (
    <section className="rounded-md border p-3">
      <h3 className="font-semibold">{t('Source inspector')}</h3>
      {!document || !anchor ? <p className="mt-2 text-sm opacity-70">{t('Select an evidence anchor to inspect its source.')}</p> : (
        <div className="mt-2 space-y-2">
          <p className="text-sm font-medium">{document.fileName}</p>
          <p dir="ltr" className="text-xs opacity-60">#{anchor.page ?? 1} · {anchor.start}–{anchor.end}</p>
          <blockquote className="whitespace-pre-wrap rounded bg-zinc-100 p-3 leading-7 dark:bg-zinc-900">{anchor.quote}</blockquote>
        </div>
      )}
    </section>
  );
}
