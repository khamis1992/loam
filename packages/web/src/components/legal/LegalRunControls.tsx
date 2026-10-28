'use client';

import { useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type ClientPosition, type LegalPipelineRun, type RiskTolerance } from '@/services/legalApi';

export function LegalRunControls<T>({ matterId, kind, label, sourceText, contract, onDone }: {
  matterId: string;
  kind: LegalPipelineRun['kind'];
  label: string;
  sourceText?: string;
  contract?: { contractId: string; contractType?: string; clientPosition?: ClientPosition; riskTolerance?: RiskTolerance };
  onDone: (state: T) => void;
}) {
  const [run, setRun] = useState<LegalPipelineRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const act = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => {
    let active = true;
    void legalApi.listRuns(matterId).then((result) => {
      const latest = result.runs.find((candidate) => candidate.kind === kind && (kind !== 'contract_review' || (candidate.state as { contractId?: string }).contractId === contract?.contractId));
      if (!active || !latest) return;
      setRun(latest);
      if (latest.status === 'succeeded') doneRef.current(latest.state as T);
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [matterId, kind, contract?.contractId]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    const timer = window.setTimeout(() => {
      void legalApi.getRun(run.id).then((result) => {
        setRun(result.run);
        if (result.run.status === 'succeeded') doneRef.current(result.run.state as T);
      }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [run?.id, run?.status]);
  const approve = () => act(async () => { if (run) setRun((await legalApi.resumeRun(run.id, { action: 'approve' })).run); });
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {!run && <button type="button" disabled={(kind === 'legal_response' && !sourceText?.trim()) || (kind === 'contract_review' && !contract?.contractId)} onClick={() => act(async () => setRun((await legalApi.startRun(matterId, kind, { sourceText, ...contract })).run))} className="rounded border px-3 py-1 disabled:opacity-50">{label}</button>}
        {run?.status === 'running' && <button type="button" onClick={() => act(async () => setRun((await legalApi.cancelRun(run.id)).run))} className="rounded border px-3 py-1">{t('Cancel run')}</button>}
        {run?.status === 'waiting' && <button type="button" onClick={() => void approve()} className="rounded border border-emerald-600 px-3 py-1">{run.stage === 'draft' ? t('Approve strategy') : t('Approve lawyer review')}</button>}
        {(run?.status === 'failed' || run?.status === 'cancelled') && <button type="button" onClick={() => act(async () => setRun((await legalApi.resumeRun(run.id)).run))} className="rounded border px-3 py-1">{t('Resume run')}</button>}
      </div>
      {run && <div className="text-xs opacity-75" role="status" aria-live="polite">
        <p>{t(run.status)} · {t(run.stage)} · {run.completedStages.length}/{run.stageCount ?? 10}</p>
        <p>{t('Elapsed')}: {((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000).toFixed(1)}s</p>
        <p>{t('Stage elapsed')}: {((Date.now() - Date.parse(run.updatedAt)) / 1000).toFixed(1)}s</p>
        <p dir="ltr">{run.model} · {run.corpusSnapshotId}</p>
        <progress max={run.stageCount ?? 10} value={run.completedStages.length} className="h-2 w-full" aria-label={t('Run progress')} />
        {run.error && <p className="text-amber-700 dark:text-amber-300">{run.error}</p>}
      </div>}
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
