'use client';

/**
 * Cap G §4.16 (first slice): the Agent Studio App Builder side panel — projects,
 * the prompt queue (pause/resume/remove), and the Race estimate block the composer
 * chip reads. Arabic-first, lucide icons only, brand glyph rule respected (the
 * forbidden glow/star names are enforced by noStarIcons.test). The run engine
 * surface shows the server's engine_pending state honestly until it lands.
 */
import { useEffect, useState } from 'react';
import { AppWindow, GitBranch, Pause, Play, Plus, RefreshCw, Trash2, Layers } from 'lucide-react';
import {
  loadProjects, selectProject, refreshQueue, enqueuePrompt, dropQueueItem, toggleQueuePaused, loadEstimate, setEstimateBranches,
} from '../../store/appBuilderSlice';
import { useAppSelector, useAppDispatch } from '../../store';

export function AppBuilderPanel() {
  const dispatch = useAppDispatch();
  const { projects, projectsError, selected, queue, estimate, estimateBranches, error } = useAppSelector((s) => s.appBuilder);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void dispatch(loadProjects());
  }, [dispatch]);

  useEffect(() => {
    if (selected) void dispatch(loadEstimate({ id: selected.id, branches: estimateBranches }));
  }, [dispatch, selected, estimateBranches]);

  const queued = queue?.items.filter((i) => i.status === 'queued') ?? [];

  return (
    <section dir="rtl" className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-start" aria-label="بانل بانى التطبيقات">
      <header className="flex items-center gap-2">
        <AppWindow className="size-4" aria-hidden />
        <h2 className="text-sm font-semibold">مشاريع التطبيقات</h2>
        <button
          type="button"
          className="ms-auto flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
          onClick={() => void dispatch(loadProjects())}
        >
          <RefreshCw className="size-3" aria-hidden /> تحديث
        </button>
      </header>

      {projectsError && <p className="rounded bg-red-500/10 p-2 text-xs text-red-600">{projectsError}</p>}
      {error && <p className="rounded bg-red-500/10 p-2 text-xs text-red-600">{error}</p>}

      <ul className="flex flex-col gap-1">
        {projects.length === 0 && (
          <li className="rounded border border-dashed p-3 text-xs opacity-70">لا مشاريع بعد. أنشئ أول تطبيق من مهمة بناء.</li>
        )}
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => void dispatch(selectProject(p.id))}
              className={`flex w-full flex-col gap-0.5 rounded border p-2 text-start text-xs hover:bg-black/5 dark:hover:bg-white/10 ${
                selected?.id === p.id ? 'border-current' : 'border-black/10 dark:border-white/10'
              }`}
            >
              <span className="font-semibold">{p.title}</span>
              <span dir="ltr" className="font-mono opacity-60">{p.id} · v{p.activeVersion ?? 0}</span>
            </button>
          </li>
        ))}
      </ul>

      {selected && queue && (
        <div className="flex flex-col gap-2 rounded border border-black/10 p-2 text-xs dark:border-white/10">
          <div className="flex items-center gap-2">
            <Layers className="size-3.5" aria-hidden />
            <span className="font-semibold">طابور الطلبات</span>
            {queue.paused ? (
              <button type="button" className="ms-auto flex items-center gap-1 rounded px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void dispatch(toggleQueuePaused({ id: selected.id, paused: true }))}>
                <Play className="size-3" aria-hidden /> استئناف
              </button>
            ) : (
              <button type="button" className="ms-auto flex items-center gap-1 rounded px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void dispatch(toggleQueuePaused({ id: selected.id, paused: false }))}>
                <Pause className="size-3" aria-hidden /> إيقاف مؤقت
              </button>
            )}
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void dispatch(refreshQueue(selected.id))} aria-label="تحديث الطابور">
              <RefreshCw className="size-3" aria-hidden />
            </button>
          </div>

          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const content = draft.trim();
              if (!content) return;
              setDraft('');
              void dispatch(enqueuePrompt({ id: selected.id, content }));
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="طلب جديد ينتظر دوره…"
              className="min-w-0 flex-1 rounded border border-black/10 bg-transparent px-2 py-1 dark:border-white/10"
            />
            <button type="submit" className="flex items-center gap-1 rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label="أضف إلى الطابور">
              <Plus className="size-3" aria-hidden />
            </button>
          </form>

          <ol className="flex flex-col gap-1">
            {queued.length === 0 && <li className="opacity-60">الطابور فارغ.</li>}
            {queued.map((item, index) => (
              <li key={item.id} className="flex items-center gap-2 rounded bg-black/5 px-2 py-1 dark:bg-white/10">
                <span className="opacity-60">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate" title={item.content}>{item.content}</span>
                <button type="button" aria-label="احذف الطلب" className="rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/20" onClick={() => void dispatch(dropQueueItem({ id: selected.id, itemId: item.id }))}>
                  <Trash2 className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ol>

          <div className="flex flex-col gap-1 border-t border-black/10 pt-2 dark:border-white/10">
            <div className="flex items-center gap-2">
              <GitBranch className="size-3.5" aria-hidden />
              <span>تقدير السباق</span>
              <select
                value={estimateBranches}
                onChange={(e) => dispatch(setEstimateBranches(Number(e.target.value) as 2 | 3 | 4))}
                className="ms-auto rounded border border-black/10 bg-transparent px-1 py-0.5 dark:border-white/10"
                aria-label="عدد الفروع"
              >
                <option value={2}>فرعان</option>
                <option value={3}>٣ فروع</option>
                <option value={4}>٤ فروع</option>
              </select>
            </div>
            {estimate ? (
              <p className="opacity-80">
                السباق: نحو +{estimate.extraCredits} رصيد (بحد أقصى {estimate.maxTotalCredits} إجمالًا)
                <span className="opacity-60"> · {estimate.basis === 'history' ? `من ${estimate.sampleRuns} تشغيلات سابقة` : 'بدون سجل سابق'}</span>
              </p>
            ) : (
              <p className="opacity-60">جارٍ حساب التقدير…</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default AppBuilderPanel;
