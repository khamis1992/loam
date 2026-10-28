'use client';

import { useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type ReviewParagraph, type ReviewRecord } from '@/services/legalApi';

export function ReviewComments({ review, paragraphs, reviewerName, licenseNo, onReview }: {
  review: ReviewRecord;
  paragraphs: ReviewParagraph[];
  reviewerName: string;
  licenseNo: string;
  onReview: (review: ReviewRecord) => void;
}) {
  const [paragraphIndex, setParagraphIndex] = useState(0);
  const [body, setBody] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const ready = reviewerName.trim() && licenseNo.trim();
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const downloadPackage = () => run(async () => {
    const result = await legalApi.reviewPackage(review.id);
    const blob = new Blob([Uint8Array.from(atob(result.dataBase64), (c) => c.charCodeAt(0))], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = result.fileName; link.click(); URL.revokeObjectURL(url);
  });
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label={t('Lawyer comments and decisions')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{t('Lawyer comments and decisions')}</h3>
        <button type="button" onClick={() => void downloadPackage()} className="rounded border px-3 py-1">{t('Download internal review package')}</button>
      </div>
      {review.state === 'in_review' && (
        <div className="space-y-2">
          <select aria-label={t('Paragraph to review')} value={paragraphIndex} onChange={(e) => setParagraphIndex(Number(e.target.value))} className="w-full rounded border p-2">
            {paragraphs.map((paragraph) => <option key={paragraph.index} value={paragraph.index}>{paragraph.index + 1} — {paragraph.quote.slice(0, 100)}</option>)}
          </select>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('Lawyer comment')} rows={3} className="w-full rounded border p-2" />
          <button type="button" disabled={!ready || !body.trim() || !paragraphs[paragraphIndex]} onClick={() => run(async () => {
            const paragraph = paragraphs[paragraphIndex]!;
            const result = await legalApi.addReviewComment(review.id, { anchor: { start: paragraph.start, end: paragraph.end, quote: paragraph.quote }, body, reviewerName, licenseNo });
            onReview(result.review); setBody('');
          })} className="rounded border px-3 py-1 disabled:opacity-50">{t('Add comment')}</button>
        </div>
      )}
      {review.comments.length > 0 && <ul className="space-y-2">{review.comments.map((comment) => <li key={comment.id} className="rounded border p-2"><blockquote className="text-xs opacity-70">{comment.anchor.quote}</blockquote><p>{comment.body}</p><p className="text-xs opacity-60">{comment.author.name} · {comment.author.licenseNo}</p></li>)}</ul>}
      {(review.verification?.warnings.length ?? 0) > 0 && <div className="space-y-2"><h4 className="font-medium">{t('Verification warnings')}</h4>{review.verification!.warnings.map((warning) => {
        const accepted = review.acceptedWarnings.find((item) => item.code === warning.code);
        return <div key={warning.code} className="rounded border p-2"><p>{warning.messageAr}</p>{accepted ? <p className="text-xs">{t('Accepted with reason')}: {accepted.reason}</p> : review.state === 'in_review' && <div className="mt-2 flex flex-wrap gap-2"><input value={reasons[warning.code] ?? ''} onChange={(e) => setReasons((current) => ({ ...current, [warning.code]: e.target.value }))} placeholder={t('Reason for accepting warning')} className="min-w-0 flex-1 rounded border p-2" /><button type="button" disabled={!ready || !(reasons[warning.code] ?? '').trim()} onClick={() => run(async () => onReview((await legalApi.acceptReviewWarning(review.id, { code: warning.code, reason: reasons[warning.code] ?? '', reviewerName, licenseNo })).review))} className="rounded border px-3 py-1 disabled:opacity-50">{t('Accept warning')}</button></div>}</div>;
      })}</div>}
      <p className="text-xs opacity-60">{t('Review decisions')}: {review.decisions.length}</p>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    </section>
  );
}
