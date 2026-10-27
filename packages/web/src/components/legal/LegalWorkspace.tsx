'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type DefensePackage, type DocumentAnalysisReport, type EvidenceWorkspace, type LegalResponsePackage, type LegalStatus, type Matter } from '@/services/legalApi';
import { EvidenceBoard } from './EvidenceBoard';
import { ContractReview } from './ContractReview';
import { DefenseStrategy } from './DefenseStrategy';
import { ResponseMatrix } from './ResponseMatrix';
import { DocumentAnalysisView } from './DocumentAnalysisView';
import { DocumentViewer } from './DocumentViewer';
import { PrivacyBadge } from './PrivacyBadge';
import { LegalRunControls } from './LegalRunControls';

type Tab = 'analysis' | 'evidence' | 'contract' | 'defense' | 'response' | 'document';

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function LegalWorkspace({ matterId }: { matterId: string }) {
  const [tab, setTab] = useState<Tab>('analysis');
  const [matter, setMatter] = useState<Matter | null>(null);
  const [workspace, setWorkspace] = useState<EvidenceWorkspace | null>(null);
  const [status, setStatus] = useState<LegalStatus | null>(null);
  const [analysis, setAnalysis] = useState<DocumentAnalysisReport | null>(null);
  const [defense, setDefense] = useState<DefensePackage | null>(null);
  const [response, setResponse] = useState<LegalResponsePackage | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [matterResult, documentResult, statusResult] = await Promise.all([legalApi.getMatter(matterId), legalApi.getMatterDocuments(matterId), legalApi.status()]);
      setMatter(matterResult.matter); setWorkspace(documentResult); setStatus(statusResult);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [matterId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const upload = async (file: File) => act(async () => {
    await legalApi.uploadMatterDocument(matterId, file.name, await fileBase64(file));
    await refresh();
  });
  return (
    <main className="space-y-3 p-3 text-sm [&_input]:bg-bg-main [&_input]:text-text-primary [&_select]:bg-bg-main [&_select]:text-text-primary [&_textarea]:bg-bg-main [&_textarea]:text-text-primary">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-lg font-semibold">{matter?.title ?? t('Legal workspace')}</h1><p dir="ltr" className="text-xs opacity-60">{matter?.kind} · {matter?.asOf}</p></div>
        {status && <PrivacyBadge local={status.localModelApproved} keyAvailable={status.keyAvailable} />}
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <LegalRunControls matterId={matterId} kind="document_analysis" label={t('Analyze documents')} onDone={(result: { report: DocumentAnalysisReport }) => setAnalysis(result.report)} />
        <LegalRunControls matterId={matterId} kind="defense_memo" label={t('Build defense')} onDone={setDefense} />
      </div>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      <nav role="tablist" className="flex flex-wrap gap-1 border-b">
        {(['analysis', 'evidence', 'contract', 'defense', 'response', 'document'] as const).map((id) => <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)} className={`px-3 py-1 ${tab === id ? 'border-b-2 border-teal-600 font-semibold' : ''}`}>{t(id)}</button>)}
      </nav>
      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)]">
        <aside aria-label={t('Source document')}><DocumentViewer document={workspace?.documents[0]} /></aside>
        <section>
          {tab === 'analysis' && (analysis ? <DocumentAnalysisView report={analysis} /> : <p className="opacity-70">{t('Run document analysis to see the report.')}</p>)}
          {tab === 'evidence' && workspace && <EvidenceBoard workspace={workspace} />}
          {tab === 'contract' && <ContractReview matterId={matterId} />}
          {tab === 'defense' && (defense ? <DefenseStrategy result={defense} /> : <p className="opacity-70">{t('Build a defense to see the strategy.')}</p>)}
          {tab === 'response' && (
            <div className="space-y-3">
              <textarea dir="auto" rows={6} value={sourceText} onChange={(e) => setSourceText(e.target.value)} placeholder={t('Paste the opposing memorandum or legal letter')} className="w-full rounded border p-2" />
              <LegalRunControls matterId={matterId} kind="legal_response" label={t('Build legal response')} sourceText={sourceText} onDone={setResponse} />
              {response && <ResponseMatrix result={response} />}
            </div>
          )}
          {tab === 'document' && workspace && <DocumentViewer document={workspace.documents[0]} />}
        </section>
        <aside aria-label={t('Evidence and notes')}>{workspace && <EvidenceBoard workspace={workspace} />}</aside>
      </div>
    </main>
  );
}
