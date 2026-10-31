'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type LibraryFolder, type LibraryHit, type LibraryStatus } from '@/services/legalApi';

/** Fixed warning: library status tags are inferred and must be verified before citing. */
export const LIBRARY_BANNER_AR = 'الوسوم مستنتجة من بيانات الميزان — تحقّق قبل الاستشهاد الحاسم. نتائج المكتبة مراجع بحثية غير مُتحقَّقة ولا تُصدَّر نهائياً قبل اجتياز فحص الاستشهادات.';

const CHIP: Record<LibraryStatus, { text: string; cls: string }> = {
  in_force: { text: 'نافذ', cls: 'border-emerald-600/50 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' },
  added: { text: 'نافذ — مضافة', cls: 'border-emerald-600/50 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' },
  amended: { text: 'نافذ — معدّل', cls: 'border-amber-600/50 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200' },
  superseded: { text: 'نص سابق (مستبدل)', cls: 'border-red-600/50 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200' },
  repealed: { text: 'ملغاة', cls: 'border-red-600/50 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200' },
  unknown: { text: 'حالة غير معروفة', cls: 'border-zinc-400/60 bg-zinc-50 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300' },
};

export function LibraryStatusChip({ status }: { status: LibraryStatus }) {
  const c = CHIP[status] ?? CHIP.unknown;
  return (
    <span data-status={status} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${c.cls}`}>
      {c.text}<span aria-hidden="true">·</span><span>{'مستنتج'}</span>
    </span>
  );
}

export function LibraryBanner() {
  return (
    <div role="note" dir="rtl" data-testid="library-banner" className="sticky top-0 z-10 rounded-md border border-amber-600/50 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <strong>{'⚠️ '}</strong>{LIBRARY_BANNER_AR}
    </div>
  );
}

export function LibraryResults({ hits }: { hits: LibraryHit[] }) {
  if (!hits.length) return <p className="text-sm opacity-70">{t('No results')}</p>;
  return (
    <ul className="divide-y rounded-md border" dir="rtl">
      {hits.map((h, i) => (
        <li key={`${h.file}#${h.article}#${i}`} className="space-y-1 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <LibraryStatusChip status={h.status} />
            <span className="rounded-full border px-2 py-0.5 text-xs opacity-80">{'غير مُتحقَّق'}</span>
            <span className="font-medium">{h.title}</span>
            <span dir="ltr" className="text-xs opacity-60">{h.ref} · {h.article}</span>
          </div>
          <p className="text-sm">{h.snippet}</p>
          {h.url && <a href={h.url} target="_blank" rel="noreferrer" className="text-xs underline opacity-80">{'التحقق على الميزان'}</a>}
        </li>
      ))}
    </ul>
  );
}

export function LibrarySearch() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState<LibraryFolder | ''>('');
  const [hits, setHits] = useState<LibraryHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { legalApi.libraryStatus().then((s) => setInstalled(s.installed)).catch(() => setInstalled(false)); }, []);
  const run = async () => {
    if (!q.trim()) return;
    setError(null);
    try { setHits((await legalApi.librarySearch(q, folder || undefined)).hits); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="space-y-2" aria-label={t('Qatar law library')}>
      <h2 className="font-semibold">{t('Qatar law library')}</h2>
      <LibraryBanner />
      {installed === false && <p className="text-sm opacity-70">{t('Library not installed. Run the weekly library sync.')}</p>}
      {installed && (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <input dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search laws, regulations, decisions, rulings')} className="min-w-0 flex-1 rounded border px-2 py-1" />
          <select aria-label={t('Library section')} value={folder} onChange={(e) => setFolder(e.target.value as LibraryFolder | '')} className="rounded border px-2 py-1">
            <option value="">{t('All')}</option><option value="laws">{'قوانين'}</option><option value="regulations">{'لوائح'}</option><option value="decisions">{'قرارات'}</option><option value="rulings">{'أحكام'}</option>
          </select>
          <button type="submit" className="rounded border px-3 py-1">{t('Search')}</button>
        </form>
      )}
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      {hits && <LibraryResults hits={hits} />}
    </section>
  );
}
