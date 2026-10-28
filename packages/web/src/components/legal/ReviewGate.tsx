'use client';

import { useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type ReviewRecord, type VerificationReport } from '@/services/legalApi';

const STEPS: Array<{ state: ReviewRecord['state']; label: string }> = [
  { state: 'draft', label: 'Draft' },
  { state: 'verified', label: 'Citations verified' },
  { state: 'in_review', label: 'With the lawyer' },
  { state: 'approved', label: 'Approved' },
];

/**
 * Licensed-lawyer gate. Approval re-verifies the exact text on the server and
 * requires the reviewer's name and Qatar licence number; any edit after
 * approval sends the document back to draft (server-side, review.ts).
 */
export function ReviewGate({ review, text, report, onChange }: {
  review: ReviewRecord; text: string; report: VerificationReport | null; onChange: (r: ReviewRecord) => void;
}) {
  const [name, setName] = useState('');
  const [licenseNo, setLicenseNo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<{ review: ReviewRecord }>) => {
    setBusy(true); setError(null);
    try { onChange((await fn()).review); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const current = STEPS.findIndex((s) => s.state === review.state);
  const blockers = report ? report.counts.unverifiedMarkers + report.counts.failed : 0;
  return (
    <section dir="rtl" className="space-y-3 rounded-lg border p-3 text-sm">
      <ol className="flex flex-wrap gap-2" aria-label={t('Review progress')}>
        {STEPS.map((s, i) => (
          <li key={s.state} aria-current={i === current ? 'step' : undefined}
            className={`rounded-full border px-2 py-0.5 ${i <= current ? 'border-emerald-600/50 bg-emerald-50 dark:bg-emerald-950' : 'opacity-60'}`}>
            {t(s.label)}
          </li>
        ))}
        {review.state === 'rejected' && <li className="rounded-full border border-red-600/50 bg-red-50 px-2 py-0.5 dark:bg-red-950">{t('Rejected')}</li>}
      </ol>
      {review.state !== 'approved' && (
        <p className="rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t('Draft for review — not to be filed or sent before approval by a lawyer licensed in Qatar')}
        </p>
      )}
      {review.state === 'verified' && (
        <button type="button" disabled={busy} onClick={() => run(() => legalApi.submitReview(review.id))} className="rounded-md border px-3 py-1">
          {t('Send to lawyer review')}
        </button>
      )}
      {review.state === 'in_review' && (
        <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => legalApi.approveReview(review.id, text, name, licenseNo)); }}>
          <label className="grid gap-1">{t('Reviewing lawyer')}<input required value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border px-2 py-1" /></label>
          <label className="grid gap-1">{t('Licence number')}<input required dir="ltr" value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} className="rounded-md border px-2 py-1" /></label>
          <button type="submit" disabled={busy || blockers > 0 || !name.trim() || !licenseNo.trim()} className="rounded-md border border-emerald-700 px-3 py-1 sm:col-span-2">
            {blockers > 0 ? t('Resolve {n} open items before approval', { n: blockers }) : t('Approve this exact text')}
          </button>
          <label className="grid gap-1 sm:col-span-2">{t('Rejection note')}<textarea value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md border px-2 py-1" /></label>
          <button type="button" disabled={busy || !note.trim()} onClick={() => run(() => legalApi.rejectReview(review.id, note))} className="rounded-md border border-red-700 px-3 py-1 sm:col-span-2">
            {t('Return with notes')}
          </button>
        </form>
      )}
      {review.state === 'approved' && review.reviewer && (
        <p>{t('Approved by {name} ({license}) on {date}', { name: review.reviewer.name, license: review.reviewer.licenseNo, date: review.decidedAt ?? '' })}</p>
      )}
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    </section>
  );
}
