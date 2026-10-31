'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { toolFamilyIcon } from '@/components/chat/toolIcons';
import { legalApi, type LibraryFolder, type LibraryHit, type LibraryStatus } from '@/services/legalApi';

/** Fixed warning: library status tags are inferred and must be verified before citing. */
export const LIBRARY_BANNER_AR = 'الوسوم مستنتجة من بيانات الميزان — تحقّق قبل الاستشهاد الحاسم. نتائج المكتبة مراجع بحثية غير مُتحقَّقة ولا تُصدَّر نهائياً قبل اجتياز فحص الاستشهادات.';

const CHIP: Record<LibraryStatus, { text: string; cls: string }> = {
  in_force: { text: 'نافذ', cls: 'border-[var(--function-success)] bg-[var(--function-success-tsp)] text-func-success' },
  added: { text: 'نافذ — مضافة', cls: 'border-[var(--function-success)] bg-[var(--function-success-tsp)] text-func-success' },
  amended: { text: 'نافذ — معدّل', cls: 'border-[var(--function-warning)] bg-[var(--function-warning-tsp)] text-func-warning' },
  superseded: { text: 'نص سابق (مستبدل)', cls: 'border-[var(--function-error)] bg-[var(--function-error-tsp)] text-func-error' },
  repealed: { text: 'ملغاة', cls: 'border-[var(--function-error)] bg-[var(--function-error-tsp)] text-func-error' },
  unknown: { text: 'حالة غير معروفة', cls: 'border-border-main bg-fill-tsp text-text-tertiary' },
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
    <div role="note" dir="rtl" data-testid="library-banner" className="sticky top-0 z-10 flex items-start gap-2 rounded-card border border-[var(--function-warning)] bg-[var(--function-warning-tsp)] text-func-warning p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{LIBRARY_BANNER_AR}</span>
    </div>
  );
}

export function LibraryResults({ hits }: { hits: LibraryHit[] }) {
  if (!hits.length) return <p className="text-sm text-text-tertiary">{t('No results')}</p>;
  return (
    <ul className="divide-y divide-border-main rounded-card border border-border-main bg-bg-menu" dir="rtl">
      {hits.map((h, i) => (
        <li key={`${h.file}#${h.article}#${i}`} className="space-y-1 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <LibraryStatusChip status={h.status} />
            <span className="rounded-full border border-border-main px-2 py-0.5 text-xs text-text-secondary">{'غير مُتحقَّق'}</span>
            <span className="font-medium text-text-primary">{h.title}</span>
            <span dir="ltr" className="text-xs text-text-tertiary">{h.ref} · {h.article}</span>
          </div>
          <p className="text-sm text-text-secondary">{h.snippet}</p>
          {h.url && <a href={h.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--icon-blue)] transition-colors duration-fast hover:underline"><ExternalLink className="size-3" aria-hidden />{'التحقق على الميزان'}</a>}
        </li>
      ))}
    </ul>
  );
}

const SearchIcon = toolFamilyIcon('qatar_library_search');

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
      <h2 className="flex items-center gap-2 font-semibold text-text-primary"><SearchIcon className="size-4 text-text-tertiary" />{t('Qatar law library')}</h2>
      <LibraryBanner />
      {installed === false && <p className="text-sm text-text-tertiary">{t('Library not installed. Run the weekly library sync.')}</p>}
      {installed && (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <input dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search laws, regulations, decisions, rulings')} className="min-w-0 flex-1 rounded border px-2 py-1" />
          <select aria-label={t('Library section')} value={folder} onChange={(e) => setFolder(e.target.value as LibraryFolder | '')} className="rounded border px-2 py-1">
            <option value="">{t('All')}</option><option value="laws">{'قوانين'}</option><option value="regulations">{'لوائح'}</option><option value="decisions">{'قرارات'}</option><option value="rulings">{'أحكام'}</option>
          </select>
          <button type="submit" className="inline-flex items-center gap-1 rounded-control border border-border-main px-3 py-1 text-text-primary transition-colors duration-fast hover:bg-fill-hover"><SearchIcon className="size-4" aria-hidden />{t('Search')}</button>
        </form>
      )}
      {error && <p role="alert" className="text-func-error">{error}</p>}
      {hits && <LibraryResults hits={hits} />}
    </section>
  );
}
