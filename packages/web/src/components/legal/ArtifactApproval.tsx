'use client';

import { useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type ApprovalArtifact, type ReviewParagraph, type ReviewRecord } from '@/services/legalApi';
import { ReviewComments } from './ReviewComments';

export function ArtifactApproval({ matterId, documentName, dataBase64 }: { matterId: string; documentName: string; dataBase64: string }) {
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [paragraphs, setParagraphs] = useState<ReviewParagraph[]>([]);
  const [artifact, setArtifact] = useState<ApprovalArtifact | null>(null);
  const [name, setName] = useState('');
  const [licenseNo, setLicenseNo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="space-y-2 rounded-md border p-3">
      <h3 className="font-semibold">{t('Artifact review and export')}</h3>
      <p className="text-xs opacity-70">{t(review?.state ?? 'draft')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded border px-3 py-1" onClick={() => run(async () => {
          const result = await legalApi.verifyArtifact({ matterId, documentName, dataBase64 });
          setReview(result.review); setParagraphs(result.paragraphs); setArtifact(null);
          if (result.report.verdict === 'fail' || result.structure.some((issue) => issue.level === 'error')) throw new Error(t('Verification failed: the draft cannot be exported'));
        })}>{t('Verify artifact')}</button>
        <button type="button" disabled={!review || review.state !== 'verified'} className="rounded border px-3 py-1 disabled:opacity-50" onClick={() => run(async () => { setReview((await legalApi.submitReview(review!.id)).review); })}>{t('Send to lawyer review')}</button>
      </div>
      {review?.state === 'in_review' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Reviewing lawyer')} className="rounded border px-2 py-1" />
          <input required dir="ltr" value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} placeholder={t('Licence number')} className="rounded border px-2 py-1" />
          <button type="button" disabled={!name.trim() || !licenseNo.trim()} className="rounded border border-emerald-600 px-3 py-1 disabled:opacity-50" onClick={() => run(async () => {
            const result = await legalApi.approveArtifact(review.id, dataBase64, name, licenseNo);
            setReview(result.review); setArtifact(result.artifact);
          })}>{t('Approve this exact artifact')}</button>
        </div>
      )}
      {artifact && <button type="button" className="rounded border px-3 py-1" onClick={() => run(async () => {
        const result = await legalApi.exportArtifact(review!.id);
        const blob = new Blob([Uint8Array.from(atob(result.dataBase64), (c) => c.charCodeAt(0))], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = result.fileName; link.click(); URL.revokeObjectURL(url);
      })}>{t('Export approved DOCX')}</button>}
      {review && <ReviewComments review={review} paragraphs={paragraphs} reviewerName={name} licenseNo={licenseNo} onReview={setReview} />}
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    </section>
  );
}
