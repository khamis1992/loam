'use client';

/**
 * Cap G §4.16 — the Agent Studio App Builder workspace: the tabbed right-hand
 * panel that opens for a task with an App project. Tabs map to the §4.15.2
 * surface: Overview (+preflight), Console (runtime errors), Code (tree/view/
 * save with stale_file guard), Versions, Queue, Race, Usage and AI (BYOK —
 * keys are never displayed). Arabic-first RTL; lucide icons only. Areas the
 * run engine drives (Versions, publish) show the server's engine_pending
 * state honestly until that engine lands.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow, RefreshCw, X, AlertTriangle, Trash2, Wand2, FileCode2, Save, GitBranch,
  History, ListOrdered, Gauge, Bot, CheckCircle2, Loader2,
} from 'lucide-react';
import { t } from '@/i18n/t';
import {
  type AppProjectDto, type PromptQueueStateDto, type RaceEstimateDto, type RuntimeErrorRecordDto,
  getAppProject, getQueue, raceEstimate, listRuntimeErrors, clearRuntimeErrors, runtimeFixPrompt,
  getAppUsage, getProjectAi, putProjectAi, testProjectAi, listFiles, readFile, writeFile,
} from '../../services/appBuilderApi';

type Tab = 'overview' | 'console' | 'code' | 'versions' | 'queue' | 'race' | 'usage' | 'ai';

const TABS: Array<{ id: Tab; icon: typeof AppWindow; ar: string }> = [
  { id: 'overview', icon: AppWindow, ar: 'نظرة عامة' },
  { id: 'console', icon: AlertTriangle, ar: 'الكونسول' },
  { id: 'code', icon: FileCode2, ar: 'الكود' },
  { id: 'versions', icon: History, ar: 'الإصدارات' },
  { id: 'queue', icon: ListOrdered, ar: 'الطابور' },
  { id: 'race', icon: GitBranch, ar: 'مقارنة الفروع' },
  { id: 'usage', icon: Gauge, ar: 'الاستخدام' },
  { id: 'ai', icon: Bot, ar: 'الذكاء' },
];

const smallBtn = 'flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10';
const box = 'flex flex-col gap-2 rounded border border-black/10 p-2 text-xs dark:border-white/10';

export function AppBuilderWorkspace({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [project, setProject] = useState<AppProjectDto | null>(null);
  const [queue, setQueue] = useState<PromptQueueStateDto | null>(null);
  const [estimate, setEstimate] = useState<RaceEstimateDto | null>(null);
  const [branches, setBranches] = useState<2 | 3 | 4>(2);
  const [error, setError] = useState<string | null>(null);

  const reloadCore = useCallback(async () => {
    try {
      const detail = await getAppProject(projectId);
      setProject(detail.project);
      setQueue(detail.queue);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل المشروع');
    }
  }, [projectId]);

  useEffect(() => { void reloadCore(); }, [reloadCore]);
  useEffect(() => {
    void raceEstimate(projectId, branches).then((r) => setEstimate(r.estimate)).catch(() => setEstimate(null));
  }, [projectId, branches]);

  return (
    <aside dir="rtl" className="flex h-full w-full flex-col border-s border-border-main bg-bg-panel" aria-label="مساحة بانى التطبيقات">
      <header className="flex h-row items-center gap-2 border-b border-border-main px-3">
        <AppWindow className="size-4 text-text-secondary" aria-hidden />
        <span className="truncate text-sm font-semibold text-text-primary">{project?.title ?? t('App projects')}</span>
        <button type="button" className={`${smallBtn} ms-auto`} onClick={() => void reloadCore()} aria-label={t('Refresh')}>
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
        <button type="button" className={smallBtn} onClick={onClose} aria-label={t('Close')}>
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-border-main px-2 py-1" role="tablist">
        {TABS.map(({ id, icon: Icon, ar }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${tab === id ? 'bg-fill-tsp text-icon-blue' : 'text-text-secondary hover:bg-fill-hover'}`}
          >
            <Icon className="size-3.5" aria-hidden /> {ar}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto p-3 text-xs text-text-primary">
        {error && <p className="mb-2 rounded bg-red-500/10 p-2 text-red-600">{error}</p>}
        {tab === 'overview' && project && <OverviewTab project={project} />}
        {tab === 'console' && project && <ConsoleTab projectId={project.id} />}
        {tab === 'code' && project && <CodeTab projectId={project.id} />}
        {tab === 'versions' && <VersionsTab />}
        {tab === 'queue' && queue && <QueueTab queue={queue} onChanged={reloadCore} />}
        {tab === 'race' && (
          <div className={box}>
            <p className="flex items-center gap-1 font-semibold"><GitBranch className="size-3.5" aria-hidden /> {t('Compare branches estimate')}</p>
            <label className="flex items-center gap-2">
              عدد الفروع
              <select value={branches} onChange={(e) => setBranches(Number(e.target.value) as 2 | 3 | 4)} className="rounded border border-border-main bg-transparent px-1 py-0.5">
                <option value={2}>فرعان</option>
                <option value={3}>٣</option>
                <option value={4}>٤</option>
              </select>
            </label>
            {estimate ? (
              <p className="text-text-secondary">
                مقارنة الفروع: نحو +{estimate.extraCredits} رصيد (بحد أقصى {estimate.maxTotalCredits} إجمالًا)
                {' · '}{estimate.basis === 'history' ? `من ${estimate.sampleRuns} تشغيلات سابقة` : 'بدون سجل سابق'}
              </p>
            ) : <p className="text-text-tertiary">جارٍ الحساب…</p>}
            <p className="text-text-tertiary">تشغيل مقارنة الفروع الفعلي ينتظر محرك التشغيل متعدد الوكلاء.</p>
          </div>
        )}
        {tab === 'usage' && project && <UsageTab projectId={project.id} />}
        {tab === 'ai' && project && <AiTab projectId={project.id} />}
      </div>
    </aside>
  );
}

function OverviewTab({ project }: { project: AppProjectDto }) {
  const rows: Array<[string, string]> = [
    ['المعرّف', project.id],
    ['الحالة', project.status],
    ['الإصدار النشط', project.activeVersion === null ? '—' : `v${project.activeVersion}`],
    ['النمط', project.defaultFlavor === 'goal' ? 'Goal' : 'Build'],
    ['أنشئ', new Date(project.createdAt).toLocaleString('ar')],
    ['آخر تحديث', new Date(project.updatedAt).toLocaleString('ar')],
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <FragmentRow key={k} k={k} v={v} />
        ))}
      </dl>
      {project.description && <p className="text-text-secondary">{project.description}</p>}
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return <>
    <dt className="font-semibold text-text-secondary">{k}</dt>
    <dd dir={k === 'المعرّف' ? 'ltr' : undefined} className="truncate font-mono">{v}</dd>
  </>;
}

function ConsoleTab({ projectId }: { projectId: string }) {
  const [errors, setErrors] = useState<RuntimeErrorRecordDto[]>([]);
  const [fix, setFix] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void listRuntimeErrors(projectId).then((r) => setErrors(r.errors)).catch(() => setErrors([]));
  }, [projectId]);
  useEffect(load, [load]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <button type="button" className={smallBtn} onClick={load}><RefreshCw className="size-3" aria-hidden /> تحديث</button>
        <button type="button" className={smallBtn} onClick={async () => { await clearRuntimeErrors(projectId).catch(() => {}); load(); }}><Trash2 className="size-3" aria-hidden /> مسح الكل</button>
        <button type="button" className={smallBtn} disabled={busy || errors.length === 0} onClick={async () => {
          setBusy(true);
          try { setFix((await runtimeFixPrompt(projectId)).prompt); } catch { setFix('تعذر بناء طلب الإصلاح'); } finally { setBusy(false); }
        }}><Wand2 className="size-3" aria-hidden /> اطلب إصلاحًا</button>
      </div>
      {errors.length === 0 && <p className="text-text-tertiary">لا أخطاء مسجلة.</p>}
      <ul className="flex flex-col gap-1">
        {errors.map((e) => (
          <li key={e.id} className="rounded bg-red-500/5 p-2">
            <p className="font-mono" dir="ltr">{e.kind} ×{e.count} · {new Date(e.lastSeenAt).toLocaleTimeString('ar')}</p>
            <p className="mt-0.5 break-all">{e.message}</p>
            {e.source && <p className="font-mono text-text-tertiary" dir="ltr">{e.source.file}:{e.source.line}:{e.source.column}</p>}
          </li>
        ))}
      </ul>
      {fix && (
        <div className="rounded border border-border-main p-2">
          <p className="mb-1 font-semibold">اطلب من الوكيل إصلاح الأخطاء:</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-fill-tsp p-2 font-mono text-[11px]" dir="ltr">{fix}</pre>
          <button type="button" className={`${smallBtn} mt-1`} onClick={() => void navigator.clipboard?.writeText(fix).then(() => {})}>نسخ</button>
        </div>
      )}
    </div>
  );
}

function CodeTab({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<{ path: string; content: string; sha1: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void listFiles(projectId).then((r) => { setFiles(r.files); setTruncated(r.truncated); }).catch(() => setFiles([]));
  }, [projectId]);

  const shown = useMemo(() => (filter ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) : files), [files, filter]);

  const openFile = async (path: string) => {
    setLoading(true);
    try {
      const r = await readFile(projectId, path);
      setOpen({ path, content: r.content, sha1: r.sha1 });
      setDraft(r.content);
      setSaveMsg(null);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'تعذر فتح الملف');
    } finally { setLoading(false); }
  };

  const save = async () => {
    if (!open) return;
    try {
      const r = await writeFile(projectId, open.path, draft, open.sha1);
      setOpen({ ...open, content: draft, sha1: r.sha1 });
      setSaveMsg('حُفظ ✓');
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'تعذر الحفظ');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="تصفية الملفات…" className="rounded border border-border-main bg-transparent px-2 py-1" dir="ltr" />
      {truncated && <p className="text-function-warning">الشجرة كبيرة — عُرضت أول 5000 ملف.</p>}
      <div className="flex min-h-0 flex-1 gap-2">
        <ul className="w-44 shrink-0 overflow-y-auto font-mono text-[11px]" dir="ltr">
          {shown.map((f) => (
            <li key={f}>
              <button type="button" onClick={() => void openFile(f)} className={`w-full truncate rounded px-1.5 py-0.5 text-start hover:bg-fill-hover ${open?.path === f ? 'bg-fill-tsp text-icon-blue' : ''}`} title={f}>{f}</button>
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {loading && <p className="flex items-center gap-1 text-text-tertiary"><Loader2 className="size-3 animate-spin" aria-hidden /> جارٍ الفتح…</p>}
          {open && (
            <>
              <div className="flex items-center gap-1">
                <span className="truncate font-mono text-[11px] text-text-secondary" dir="ltr">{open.path}</span>
                <button type="button" className={`${smallBtn} ms-auto`} onClick={() => void save()}><Save className="size-3" aria-hidden /> حفظ</button>
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                dir="ltr"
                className="min-h-0 flex-1 resize-none rounded border border-border-main bg-fill-tsp p-2 font-mono text-[11px] outline-none"
              />
            </>
          )}
          {saveMsg && <p className={saveMsg === 'حُفظ ✓' ? 'text-func-success' : 'text-function-warning'}>{saveMsg}</p>}
        </div>
      </div>
    </div>
  );
}

function VersionsTab() {
  return (
    <div className={box}>
      <p className="flex items-center gap-1 font-semibold"><History className="size-3.5" aria-hidden /> الإصدارات</p>
      <p className="text-text-secondary">إدارة الإصدارات (استعادة/ريمكس/نشر) تعمل عبر محرك التشغيل متعدد الوكلاء، وستُفعّل معه. مخزن الإصدارات نفسه مكتمل في قاعدة البيانات.</p>
    </div>
  );
}

function QueueTab({ queue, onChanged }: { queue: PromptQueueStateDto; onChanged: () => void }) {
  const items = queue.items.filter((i) => i.status === 'queued');
  return (
    <div className={box}>
      <p className="flex items-center gap-1 font-semibold"><ListOrdered className="size-3.5" aria-hidden /> طابور الطلبات {queue.paused ? '· متوقف مؤقتًا' : ''}</p>
      {items.length === 0 && <p className="text-text-tertiary">الطابور فارغ.</p>}
      <ol className="flex flex-col gap-1">
        {items.map((item, i) => (
          <li key={item.id} className="rounded bg-fill-tsp px-2 py-1">
            <span className="text-text-tertiary">{i + 1}.</span> {item.content}
          </li>
        ))}
      </ol>
      <button type="button" className={smallBtn} onClick={onChanged}><RefreshCw className="size-3" aria-hidden /> تحديث</button>
    </div>
  );
}

function UsageTab({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [totals, setTotals] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    void getAppUsage(projectId).then((r) => { setRows(r.rows); setTotals(r.totals); }).catch(() => setRows([]));
  }, [projectId]);
  return (
    <div className="flex flex-col gap-2">
      {totals && (
        <p className="text-text-secondary">
          الإجمالي: {totals.calls ?? 0} نداء · {Math.round((totals.durationMs ?? 0) / 1000)} ثانية · {(((totals.promptTokens ?? 0) + (totals.completionTokens ?? 0)) / 1000).toFixed(1)}k توكن
        </p>
      )}
      {rows.length === 0 && <p className="text-text-tertiary">لا استخدام مسجل بعد.</p>}
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-text-tertiary">
            <th className="border-b border-border-main p-1 text-start">الدور</th>
            <th className="border-b border-border-main p-1 text-start">الخطوة</th>
            <th className="border-b border-border-main p-1 text-start">نداءات</th>
            <th className="border-b border-border-main p-1 text-start">توكن</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="border-b border-border-main p-1">{String(r.role)}</td>
              <td className="border-b border-border-main p-1 font-mono" dir="ltr">{String(r.step)}</td>
              <td className="border-b border-border-main p-1">{String(r.calls)}</td>
              <td className="border-b border-border-main p-1" dir="ltr">{Number(r.promptTokens ?? 0) + Number(r.completionTokens ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AiTab({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<{ keySource: string; effective: { baseUrl: string; model: string; hasKey: boolean }; dailyTokenCap: number | null } | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [cap, setCap] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void getProjectAi(projectId).then((r) => {
      setConfig(r.config);
      setBaseUrl(r.config.effective.baseUrl);
      setModel(r.config.effective.model);
      setCap(r.config.dailyTokenCap === null ? '' : String(r.config.dailyTokenCap));
    }).catch(() => setConfig(null));
  }, [projectId]);
  useEffect(load, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await putProjectAi(projectId, {
        baseUrl: baseUrl || null,
        model: model || null,
        ...(key ? { key } : {}),
        ...(cap ? { dailyTokenCap: Number(cap) } : { dailyTokenCap: null }),
      });
      setConfig(r.config);
      setKey('');
      setMsg('حُفظ ✓ — المفتاح لا يُعرض أبدًا بعد حفظه');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2">
      {config && (
        <p className="flex items-center gap-1 text-text-secondary">
          <CheckCircle2 className="size-3.5 text-func-success" aria-hidden />
          مصدر المفتاح: {config.keySource === 'project' ? 'مفتاح هذا المشروع' : config.keySource === 'default' ? 'المفتاح الافتراضي' : 'لا مفتاح'}
        </p>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-secondary">Provider URL (متوافق OpenAI، https فقط)</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} dir="ltr" placeholder="https://api.openai.com/v1" className="rounded border border-border-main bg-transparent px-2 py-1 font-mono text-[11px]" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-secondary">الموديل</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} dir="ltr" placeholder="gpt-…" className="rounded border border-border-main bg-transparent px-2 py-1 font-mono text-[11px]" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-secondary">مفتاح API (خاص لهذا المشروع — يُحفظ ختمًا ولا يُعرض مجددًا)</span>
        <input value={key} onChange={(e) => setKey(e.target.value)} type="password" dir="ltr" placeholder="sk-…" className="rounded border border-border-main bg-transparent px-2 py-1 font-mono text-[11px]" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-secondary">حد التوكنات اليومي للتطبيق (فارغ = بلا حد)</span>
        <input value={cap} onChange={(e) => setCap(e.target.value)} dir="ltr" inputMode="numeric" className="rounded border border-border-main bg-transparent px-2 py-1 font-mono text-[11px]" />
      </label>
      <div className="flex items-center gap-1">
        <button type="button" className={smallBtn} disabled={busy} onClick={() => void save()}><Save className="size-3" aria-hidden /> حفظ</button>
        <button type="button" className={smallBtn} disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await save();
            const r = await testProjectAi(projectId);
            setMsg(r.ok ? 'المفتاح يعمل ✓' : `فشل الاختبار: ${r.error ?? r.status}`);
          } catch (e) { setMsg(e instanceof Error ? e.message : 'تعذر الاختبار'); } finally { setBusy(false); }
        }}><Wand2 className="size-3" aria-hidden /> اختبر المفتاح</button>
      </div>
      {msg && <p className="text-text-secondary">{msg}</p>}
      <p className="text-text-tertiary">مفتاحك يُعطى لخادم تطبيقك فقط، ولا يُكتب في ملفات المشروع ولا يظهر في السجلات.</p>
    </div>
  );
}

export default AppBuilderWorkspace;
