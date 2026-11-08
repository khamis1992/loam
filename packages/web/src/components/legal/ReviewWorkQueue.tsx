'use client';

import { useMemo, useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type ReviewRecord, type ReviewState } from '@/services/legalApi';

function saveBase64(dataBase64: string, fileName: string, type: string): void {
  const blob = new Blob([Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0))], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ReviewWorkQueue({ reviews, onChange }: { reviews: ReviewRecord[]; onChange: (reviews: ReviewRecord[]) => void }) {
  const [filter, setFilter] = useState<'attention' | 'all' | ReviewState>('attention');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewerName, setReviewerName] = useState('');
  const [licenseNo, setLicenseNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useMemo(() => reviews.filter((review) => filter === 'all' || review.state === filter || (filter === 'attention' && review.state !== 'approved')), [filter, reviews]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const submit = (ids: string[]) => run(async () => {
    for (const id of ids) await legalApi.submitReview(id);
    setSelected(new Set()); onChange((await legalApi.getMatter(reviews[0]?.matterId ?? '')).reviews);
  });
  const assign = () => run(async () => {
    for (const id of selected) await legalApi.assignReview(id, reviewerName, licenseNo);
    setSelected(new Set()); onChange((await legalApi.getMatter(reviews[0]?.matterId ?? '')).reviews);
  });
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="space-y-3 rounded-md border p-3" aria-label={t('Review work queue')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('Review work queue')}</h2>
        <select aria-label={t('Filter reviews')} value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="rounded border px-2 py-1">
          <option value="attention">{t('Needs attention')}</option><option value="all">{t('All reviews')}</option>
          <option value="draft">{t('draft')}</option><option value="verified">{t('verified')}</option><option value="in_review">{t('in_review')}</option><option value="approved">{t('approved')}</option><option value="rejected">{t('rejected')}</option>
        </select>
      </div>
      {reviews.length > 0 && <div className="grid gap-2 rounded bg-zinc-50 p-2 dark:bg-zinc-900 sm:grid-cols-[minmax(0,1fr)_10rem_auto_auto]">
        <label className="grid gap-1 text-xs">{t('Reviewer to assign')}<input value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} className="rounded border px-2 py-1" /></label>
        <label className="grid gap-1 text-xs">{t('Licence number')}<input dir="ltr" value={licenseNo} onChange={(event) => setLicenseNo(event.target.value)} className="rounded border px-2 py-1" /></label>
        <button type="button" disabled={busy || selected.size === 0 || !reviewerName.trim() || !licenseNo.trim()} onClick={() => void assign()} className="self-end rounded border px-3 py-1 disabled:opacity-50">{t('Assign selected')}</button>
        <button type="button" disabled={busy || ![...selected].some((id) => reviews.find((review) => review.id === id)?.state === 'verified')} onClick={() => void submit([...selected].filter((id) => reviews.find((review) => review.id === id)?.state === 'verified'))} className="self-end rounded border px-3 py-1 disabled:opacity-50">{t('Submit selected')}</button>
      </div>}
      <ul className="divide-y rounded border">
        {visible.map((review) => {
          const blockers = (review.verification?.counts.failed ?? 0) + (review.verification?.counts.unverifiedMarkers ?? 0);
          return <li key={review.id} className="flex flex-wrap items-center gap-3 p-3">
            <input type="checkbox" aria-label={t('Select {name}', { name: review.documentName })} checked={selected.has(review.id)} onChange={() => toggle(review.id)} />
            <div className="min-w-0 flex-1"><strong>{review.documentName}</strong><p className="text-xs opacity-70">{t(review.state)} · {review.comments.length} {t('comments')} · {review.decisions.length} {t('decisions')}</p><p className="text-xs">{review.assignedReviewer ? t('Assigned to {name}', { name: review.assignedReviewer.name }) : t('Unassigned')}</p></div>
            {blockers > 0 && <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">{t('{n} blockers', { n: blockers })}</span>}
            {review.state === 'verified' && <button type="button" disabled={busy} onClick={() => void submit([review.id])} className="rounded border px-2 py-1">{t('Send to lawyer review')}</button>}
            <button type="button" onClick={() => void run(async () => { const result = await legalApi.reviewPackage(review.id); saveBase64(result.dataBase64, result.fileName, 'application/json;charset=utf-8'); })} className="rounded border px-2 py-1">{t('Review package')}</button>
            {review.state === 'approved' && review.documentName.endsWith('.docx') && <button type="button" onClick={() => void run(async () => { const result = await legalApi.exportArtifact(review.id); saveBase64(result.dataBase64, result.fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); })} className="rounded border px-2 py-1">{t('Export approved DOCX')}</button>}
          </li>;
        })}
        {visible.length === 0 && <li className="p-3 opacity-70">{t('No reviews in this view')}</li>}
      </ul>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    </section>
  );
}
