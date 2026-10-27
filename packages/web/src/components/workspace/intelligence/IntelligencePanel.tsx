'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { WorkspaceFile } from '../types';
import { applyOfficeRun, cancelOfficeRun, getOfficeRun, startOfficeRun, type OfficeRun } from './officeIntelligenceApi';

const CAPABILITIES: Record<string, Array<{ id: string; label: string }>> = {
  doc: [
    { id: 'doc-summary', label: 'تلخيص موثق' },
    { id: 'doc-grounded-draft', label: 'صياغة بالسياق والمصادر' },
    { id: 'doc-actions', label: 'استخراج القرارات والمهام' },
    { id: 'legal-matter-timeline', label: 'التسلسل الزمني للقضية' },
    { id: 'legal-evidence-matrix', label: 'مصفوفة الادعاء والإثبات' },
    { id: 'legal-partner-review', label: 'مراجعة بمنهج الشريك' },
    { id: 'legal-contract-review', label: 'مراجعة العقد والمخاطر' },
  ],
  sheet: [
    { id: 'sheet-analysis', label: 'تحليل البيانات' },
    { id: 'sheet-formula', label: 'شرح الصيغة' },
    { id: 'sheet-cleaning', label: 'اقتراح تنظيف البيانات' },
    { id: 'sheet-anomalies', label: 'كشف القيم الشاذة' },
    { id: 'sheet-forecast', label: 'توقع إرشادي' },
  ],
  slides: [
    { id: 'slides-storyboard', label: 'بناء قصة العرض' },
    { id: 'slides-deck', label: 'اقتراح عرض بالمصادر' },
    { id: 'legal-client-brief', label: 'موجز قانوني للعميل' },
  ],
};

const STATUS: Record<OfficeRun['status'], string> = {
  queued: 'في الانتظار', running: 'جارٍ التحليل', succeeded: 'اكتمل', failed: 'فشل', cancelled: 'أُلغي',
};

export default function IntelligencePanel({ file, applyDisabled = false, onApplied }: {
  file: WorkspaceFile;
  applyDisabled?: boolean;
  onApplied?: () => void;
}) {
  const capabilities = useMemo(() => CAPABILITIES[file.kind] ?? [], [file.kind]);
  const [open, setOpen] = useState(false);
  const [capability, setCapability] = useState(capabilities[0]?.id ?? '');
  const [instruction, setInstruction] = useState('');
  const [run, setRun] = useState<OfficeRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRun(null);
    setError(null);
    setCapability(CAPABILITIES[file.kind]?.[0]?.id ?? '');
  }, [file.taskId, file.path, file.kind]);

  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getOfficeRun(run.id);
        if (!cancelled) setRun(next);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    }, 900);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [run]);

  if (!capabilities.length) return null;

  const start = async () => {
    setBusy(true); setError(null);
    try { setRun(await startOfficeRun(file, capability, instruction.trim())); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!run) return;
    setBusy(true);
    try { setRun(await cancelOfficeRun(run.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!run) return;
    setBusy(true); setError(null);
    try { await applyOfficeRun(run.id); setRun(null); onApplied?.(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const active = run?.status === 'queued' || run?.status === 'running';

  return (
    <section className="border-t border-border-main bg-bg-menu text-text-primary" aria-label="المساعد الذكي">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-sm hover:bg-fill-hover" aria-expanded={open}>
        <Sparkles className="size-4 text-brand" aria-hidden />
        <span className="font-medium">المساعد الذكي والقانوني</span>
        <span className="flex-1" />
        {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </button>
      {open ? <div className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto border-t border-border-light px-3 py-3">
        <div className="flex flex-wrap gap-2">
          <select aria-label="نوع التحليل" value={capability} onChange={(event) => setCapability(event.target.value)} disabled={active || busy} className="min-h-9 min-w-48 flex-1 rounded-control border border-border-main bg-bg-main px-2 text-sm">
            {capabilities.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          {!active ? <Button variant="primary" size="sm" onClick={start} loading={busy}>{run ? 'تشغيل جديد' : 'تشغيل'}</Button> : <Button variant="secondary" size="sm" onClick={cancel} loading={busy}><X className="size-4" />إلغاء</Button>}
        </div>
        <textarea aria-label="تعليمات المساعد" dir="auto" value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={active || busy} placeholder="صف المطلوب أو حدد نطاق التحليل؛ اتركه فارغًا للتحليل العام" className="min-h-16 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm outline-none focus:border-brand" />
        {error ? <p role="alert" className="text-sm text-func-error">{error}</p> : null}
        {run ? <div className="flex flex-col gap-2 rounded-card border border-border-light bg-bg-main p-3">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            {active ? <Loader2 className="size-4 animate-spin" /> : null}
            <span>{STATUS[run.status]}</span><span>•</span><span>{capabilities.find((item) => item.id === run.capability)?.label ?? run.capability}</span>
          </div>
          {run.error ? <p role="alert" className="text-sm text-func-error">{run.error}</p> : null}
          {run.result ? <>
            <p className="whitespace-pre-wrap text-sm font-medium">{run.result.summary}</p>
            {run.result.content ? <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-control bg-bg-menu p-2 text-sm">{run.result.content}</div> : null}
            {run.result.warnings.length ? <ul className="list-disc ps-5 text-xs text-func-warning">{run.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
            {run.result.citations.length ? <details className="text-xs"><summary className="cursor-pointer text-text-secondary">المصادر ({run.result.citations.length})</summary><ol className="mt-2 flex flex-col gap-2">{run.result.citations.map((source) => <li key={source.id} className="rounded-control bg-bg-menu p-2"><span className="font-mono text-text-tertiary">{source.kind}:{source.anchor}</span><p className="mt-1 whitespace-pre-wrap">{source.excerpt}</p></li>)}</ol></details> : null}
            {run.result.data !== undefined ? <details className="text-xs"><summary className="cursor-pointer text-text-secondary">البيانات والنتائج التفصيلية</summary><pre className="mt-2 max-h-56 overflow-auto rounded-control bg-bg-menu p-2 font-mono" dir="ltr">{JSON.stringify(run.result.data, null, 2)}</pre></details> : null}
            {run.result.changeSet ? <div className="rounded-control border border-border-main p-2"><p className="text-sm font-medium">معاينة التعديلات</p><ul className="my-2 list-disc ps-5 text-xs">{run.result.changeSet.preview.map((item, index) => <li key={index}>{item}</li>)}</ul><Button variant="primary" size="sm" onClick={apply} loading={busy} disabled={applyDisabled} title={applyDisabled ? 'احفظ تعديلاتك الحالية أولًا' : undefined}>اعتماد وتطبيق</Button>{applyDisabled ? <p className="mt-1 text-xs text-func-warning">احفظ تعديلاتك الحالية قبل تطبيق اقتراح الذكاء.</p> : null}</div> : null}
          </> : null}
        </div> : null}
      </div> : null}
    </section>
  );
}
