'use client';

import { useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type ClientPosition, type ContractReviewReport, type RiskTolerance } from '@/services/legalApi';
import { ArtifactApproval } from './ArtifactApproval';
import { LegalRunControls } from './LegalRunControls';

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function ContractReview({ matterId }: { matterId: string }) {
  const [contractId, setContractId] = useState('');
  const [report, setReport] = useState<ContractReviewReport | null>(null);
  const [severity, setSeverity] = useState<'all' | 'high' | 'medium' | 'low' | 'info'>('all');
  const [position, setPosition] = useState<ClientPosition>('buyer');
  const [tolerance, setTolerance] = useState<RiskTolerance>('balanced');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [clauses, setClauses] = useState<Array<{ id: string; heading: string; text: string }>>([]);
  const [redline, setRedline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setError(null);
    try {
      const base64 = await fileBase64(file);
      const text = file.name.toLowerCase().endsWith('.docx') ? '' : await file.text();
      const result = await legalApi.addContract(matterId, file.name, text, base64);
      setContractId(result.contract.id);
      setReport(null); setRedline(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const loadReport = async (nextReport: ContractReviewReport) => {
    setError(null);
    try {
      const clauseData = await legalApi.getContractClauses(matterId, contractId);
      setReport(nextReport);
      setClauses(clauseData.clauses);
      setEdits(Object.fromEntries(clauseData.clauses.map((clause) => [clause.id, clause.text])));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const makeRedline = async () => {
    if (!report) return;
    setError(null);
    try {
      const result = await legalApi.redlineContract(matterId, contractId, Object.entries(edits).map(([clauseId, newText]) => ({ clauseId, newText })));
      setRedline(result.dataBase64);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
        <input type="file" accept=".docx,.txt,.md" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <select value={position} onChange={(e) => setPosition(e.target.value as ClientPosition)} className="rounded border px-2 py-1"><option value="buyer">Buyer</option><option value="seller">Seller</option><option value="employer">Employer</option><option value="employee">Employee</option><option value="landlord">Landlord</option><option value="tenant">Tenant</option><option value="other">Other</option></select>
        <select value={tolerance} onChange={(e) => setTolerance(e.target.value as RiskTolerance)} className="rounded border px-2 py-1"><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="aggressive">Aggressive</option></select>
        <LegalRunControls matterId={matterId} kind="contract_review" label={t('Review contract')} contract={{ contractId, contractType: 'any', clientPosition: position, riskTolerance: tolerance }} onDone={(result: { report: ContractReviewReport }) => void loadReport(result.report)} />
      </div>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      {report && (
        <>
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t('Findings and negotiation')}</h3><label className="flex items-center gap-2 text-xs">{t('Severity')}<select value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} className="rounded border px-2 py-1"><option value="all">{t('All severities')}</option><option value="high">{t('high')}</option><option value="medium">{t('medium')}</option><option value="low">{t('low')}</option><option value="info">{t('info')}</option></select></label></div>
            <ul className="space-y-2">
              {report.findings.filter((finding) => severity === 'all' || finding.severity === severity).map((finding) => <li key={finding.id} className="rounded-md border p-3"><div className="flex flex-wrap items-center gap-2"><strong>{finding.titleAr}</strong><span className="rounded border px-2 py-0.5 text-xs">{t(finding.severity)}</span></div><p>{finding.explanationAr}</p>{finding.suggestionAr && <p className="text-teal-700 dark:text-teal-300">{finding.suggestionAr}</p>}{finding.unresolvedAuthorityQueries.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('Requires lawyer confirmation and authority review')}</p>}</li>)}
            </ul>
          </section>
          <section>
            <h3 className="mb-2 font-semibold">{t('Negotiation plan')}</h3>
            <ul className="space-y-1">{report.negotiation.map((item) => <li key={item.findingId}><strong>{t(item.priority)}</strong> — {item.rationale}</li>)}</ul>
          </section>
          <section className="space-y-2">
            <h3 className="font-semibold">{t('Clause edits')}</h3>
            {clauses.map((clause) => (
              <label key={clause.id} className="block text-sm">
                <span className="mb-1 block font-medium">{clause.heading}</span>
                <textarea rows={4} dir="auto" value={edits[clause.id] ?? clause.text} onChange={(e) => setEdits((current) => ({ ...current, [clause.id]: e.target.value }))} className="w-full rounded border p-2" />
              </label>
            ))}
          </section>
          <button type="button" onClick={() => void makeRedline()} className="rounded border px-3 py-1">{t('Create redline')}</button>
        </>
      )}
      {redline && <ArtifactApproval matterId={matterId} documentName={`redline-${contractId}.docx`} dataBase64={redline} />}
    </div>
  );
}
