'use client';

import { useCallback, useEffect, useState } from 'react';
import { getLocale, isRtl, t } from '@/i18n/t';
import { legalApi, type CoverageEntry, type CoverageReport, type LegalLegislation, type LegalPack } from '@/services/legalApi';
import { attestLegalPack } from './legalPack';
import { CorpusCoverage } from './CorpusCoverage';

const MATTER_KINDS = ['defense_memo', 'contract_review', 'opinion', 'research'] as const;

export function CorpusAdmin() {
  const [laws, setLaws] = useState<LegalLegislation[]>([]);
  const [entries, setEntries] = useState<CoverageEntry[]>([]);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [snapshotId, setSnapshotId] = useState('');
  const [matterKind, setMatterKind] = useState<(typeof MATTER_KINDS)[number]>('defense_memo');
  const [selectedLaw, setSelectedLaw] = useState('');
  const [packFile, setPackFile] = useState<File | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [firstReviewer, setFirstReviewer] = useState('');
  const [secondReviewer, setSecondReviewer] = useState('');
  const [rightsBasis, setRightsBasis] = useState('');
  const [rightsReference, setRightsReference] = useState('');
  const [rightsConfirmedBy, setRightsConfirmedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [lawData, manifest, current] = await Promise.all([legalApi.listLaws(), legalApi.getCoverageManifest(), legalApi.coverage(matterKind)]);
      setLaws(lawData.laws); setEntries(manifest.entries); setCoverage(current.coverage); setSnapshotId(current.snapshot.id);
      setSelectedLaw((currentLaw) => currentLaw || lawData.laws[0]?.key || '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [matterKind]);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const importPack = () => run(async () => {
    if (!packFile || !sourceFile) throw new Error(t('Select both a LegalPack and its original source file'));
    const pack = JSON.parse(await packFile.text()) as LegalPack;
    if (pack.format !== 'loam-legal-pack/1' || !Array.isArray(pack.articles)) throw new Error(t('Invalid LegalPack'));
    const attested = await attestLegalPack(pack, sourceFile, { firstReviewer, secondReviewer, rightsBasis, rightsReference, rightsConfirmedBy });
    const result = await legalApi.importPack(attested);
    setNotice(t('Imported {key}: {n} articles', { key: result.legKey, n: result.articles }));
    setPackFile(null); setSourceFile(null);
    await refresh();
  });

  return (
    <details className="rounded-md border p-3" dir={isRtl(getLocale()) ? 'rtl' : 'ltr'}>
      <summary className="cursor-pointer font-semibold">{t('Official sources and coverage')}</summary>
      <div className="mt-3 space-y-4">
        <label className="grid max-w-sm gap-1">{t('Matter kind')}
          <select value={matterKind} onChange={(event) => setMatterKind(event.target.value as typeof matterKind)} className="rounded border px-2 py-1">
            {MATTER_KINDS.map((kind) => <option key={kind} value={kind}>{t(kind)}</option>)}
          </select>
        </label>
        {coverage && <CorpusCoverage coverage={coverage} snapshotId={snapshotId} />}

        <section className="space-y-2" aria-label={t('Declared coverage sources')}>
          <h3 className="font-semibold">{t('Declared coverage sources')}</h3>
          {entries.map((entry, index) => (
            <div key={entry.legKey} className="grid gap-2 rounded border p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_auto]">
              <span>{entry.titleAr}<bdi dir="ltr" className="block text-xs opacity-60">{entry.legKey}</bdi></span>
              <label className="grid gap-1 text-xs">{t('Required for')}
                <input value={entry.requiredFor.join(',')} onChange={(event) => setEntries((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, requiredFor: event.target.value.split(',').map((kind) => kind.trim()).filter(Boolean) } : item))} className="rounded border px-2 py-1" dir="ltr" />
              </label>
              <label className="grid gap-1 text-xs">{t('Review age days')}
                <input type="number" min={1} value={entry.maxReviewAgeDays ?? 30} onChange={(event) => setEntries((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, maxReviewAgeDays: Math.max(1, Number(event.target.value) || 30) } : item))} className="rounded border px-2 py-1" />
              </label>
              <button type="button" onClick={() => setEntries((current) => current.filter((_item, itemIndex) => itemIndex !== index))} className="self-end rounded border px-2 py-1">{t('Remove')}</button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <select aria-label={t('Law to require')} value={selectedLaw} onChange={(event) => setSelectedLaw(event.target.value)} className="min-w-0 flex-1 rounded border px-2 py-1">
              {laws.map((law) => <option key={law.key} value={law.key}>{law.titleAr}</option>)}
            </select>
            <button type="button" disabled={!selectedLaw} onClick={() => {
              const law = laws.find((item) => item.key === selectedLaw);
              if (law && !entries.some((entry) => entry.legKey === law.key)) setEntries((current) => [...current, { legKey: law.key, titleAr: law.titleAr, requiredFor: [matterKind], maxReviewAgeDays: 30 }]);
            }} className="rounded border px-3 py-1">{t('Add source')}</button>
            <button type="button" disabled={busy} onClick={() => void run(async () => { await legalApi.setCoverageManifest(entries); setNotice(t('Coverage manifest saved')); await refresh(); })} className="rounded border px-3 py-1">{t('Save coverage')}</button>
          </div>
        </section>

        <section className="space-y-2" aria-label={t('Imported legislations')}>
          <h3 className="font-semibold">{t('Imported legislations')}</h3>
          <ul className="max-h-64 space-y-1 overflow-auto rounded border p-2">
            {laws.map((law) => <li key={law.key} className="border-b pb-2 last:border-0"><strong>{law.titleAr}</strong><span className="block text-xs opacity-70">{t(law.status)} · {law.source.provenance}</span><span className="block text-xs">{t('Reviewers')}: {law.source.verifiedBy ?? '—'} / {law.source.secondVerifiedBy ?? '—'}</span></li>)}
            {laws.length === 0 && <li className="opacity-70">{t('No imported legislations')}</li>}
          </ul>
        </section>

        <form className="grid gap-2 rounded border p-3" onSubmit={(event) => { event.preventDefault(); void importPack(); }}>
          <h3 className="font-semibold">{t('Import a reviewed official LegalPack')}</h3>
          <p className="text-xs opacity-75">{t('No scraping is performed. The source file and both reviewer attestations are required; importing records an attestation rather than proving reviewer identity.')}</p>
          <label className="grid gap-1">{t('LegalPack JSON')}<input required type="file" accept=".json,application/json" onChange={(event) => setPackFile(event.target.files?.[0] ?? null)} className="rounded border p-1" /></label>
          <label className="grid gap-1">{t('Original source file')}<input required type="file" accept=".pdf,.html,.htm,.txt,.md" onChange={(event) => setSourceFile(event.target.files?.[0] ?? null)} className="rounded border p-1" /></label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1">{t('First reviewer')}<input required value={firstReviewer} onChange={(event) => setFirstReviewer(event.target.value)} className="rounded border px-2 py-1" /></label>
            <label className="grid gap-1">{t('Second independent reviewer')}<input required value={secondReviewer} onChange={(event) => setSecondReviewer(event.target.value)} className="rounded border px-2 py-1" /></label>
          </div>
          <label className="grid gap-1">{t('Usage rights basis')}<input required value={rightsBasis} onChange={(event) => setRightsBasis(event.target.value)} className="rounded border px-2 py-1" /></label>
          <label className="grid gap-1">{t('Usage rights reference')}<input required value={rightsReference} onChange={(event) => setRightsReference(event.target.value)} className="rounded border px-2 py-1" /></label>
          <label className="grid gap-1">{t('Rights confirmed by')}<input required value={rightsConfirmedBy} onChange={(event) => setRightsConfirmedBy(event.target.value)} className="rounded border px-2 py-1" /></label>
          <button type="submit" disabled={busy || !packFile || !sourceFile} className="rounded border px-3 py-1 disabled:opacity-50">{t('Import attested pack')}</button>
        </form>
        {notice && <p role="status" className="text-emerald-700 dark:text-emerald-300">{notice}</p>}
        {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      </div>
    </details>
  );
}
