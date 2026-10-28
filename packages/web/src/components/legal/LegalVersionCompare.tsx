'use client';

import { useState } from 'react';
import { t } from '@/i18n/t';
import type { LegalArticleResponse } from '@/services/legalApi';

export function LegalVersionCompare({ data }: { data: LegalArticleResponse }) {
  const [from, setFrom] = useState(data.versions[0]?.avid ?? '');
  const [to, setTo] = useState(data.versions.at(-1)?.avid ?? '');
  const before = data.versions.find((version) => version.avid === from);
  const after = data.versions.find((version) => version.avid === to);
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label={t('Version history')}>
      <h3 className="font-semibold">{t('Version history')} · {data.resolved.article.label}</h3>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="text-xs">{t('From version')}<select className="mt-1 w-full rounded border p-1" value={from} onChange={(event) => setFrom(event.target.value)}>{data.versions.map((version) => <option key={version.avid} value={version.avid}>{version.effectiveFrom} · {version.origin}</option>)}</select></label>
        <label className="text-xs">{t('To version')}<select className="mt-1 w-full rounded border p-1" value={to} onChange={(event) => setTo(event.target.value)}>{data.versions.map((version) => <option key={version.avid} value={version.avid}>{version.effectiveFrom} · {version.origin}</option>)}</select></label>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <article className="rounded border p-2"><p dir="ltr" className="text-xs opacity-60">{before?.effectiveFrom} → {before?.effectiveTo ?? t('in force')}</p><blockquote className="mt-2 whitespace-pre-wrap leading-7">{before?.text ?? t('No versions available')}</blockquote></article>
        <article className="rounded border p-2"><p dir="ltr" className="text-xs opacity-60">{after?.effectiveFrom} → {after?.effectiveTo ?? t('in force')}</p><blockquote className="mt-2 whitespace-pre-wrap leading-7">{after?.text ?? t('No versions available')}</blockquote></article>
      </div>
    </section>
  );
}
