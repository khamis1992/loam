'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { t } from '@/i18n/t';
import { legalApi, type LegalStatus, type Matter } from '@/services/legalApi';
import { PrivacyBadge } from './PrivacyBadge';

export function LegalHome() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [status, setStatus] = useState<LegalStatus | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Matter['kind']>('defense_memo');
  const [asOf, setAsOf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => Promise.all([legalApi.listMatters(), legalApi.status()]).then(([list, current]) => { setMatters(list.matters); setStatus(current); }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void refresh(); }, []);
  const create = async () => {
    if (!title.trim()) return;
    setError(null);
    try {
      await legalApi.createMatter({ title, kind, ...(asOf ? { asOf } : {}) });
      setTitle('');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 [&_input]:bg-bg-main [&_input]:text-text-primary [&_select]:bg-bg-main [&_select]:text-text-primary">
      <header className="flex items-center justify-between">
        <div><h1 className="text-xl font-semibold">{t('Loam Legal Qatar')}</h1><p className="text-sm opacity-70">{t('Evidence-bound legal analysis, contracts, defense and responses')}</p></div>
        {status && <PrivacyBadge local={status.localModelApproved} keyAvailable={status.keyAvailable} />}
      </header>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      <form className="flex flex-wrap gap-2 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('Matter title')} className="min-w-0 flex-1 rounded border px-2 py-1" />
        <input type="date" aria-label={t('Applicable law date')} value={asOf} onChange={(e) => setAsOf(e.target.value)} className="rounded border px-2 py-1" />
        <select value={kind} onChange={(e) => setKind(e.target.value as Matter['kind'])} className="rounded border px-2 py-1">
          <option value="defense_memo">{t('Defense memorandum')}</option><option value="contract_review">{t('Contract review')}</option><option value="opinion">{t('Legal opinion')}</option><option value="research">{t('Document analysis')}</option>
        </select>
        <button type="submit" className="rounded border px-3 py-1">{t('New matter')}</button>
      </form>
      <section>
        <h2 className="mb-2 font-semibold">{t('Matters')}</h2>
        <ul className="divide-y rounded-md border">
          {matters.map((matter) => (
            <li key={matter.id}>
              <Link href={`/legal/matter?id=${encodeURIComponent(matter.id)}`} className="flex items-center justify-between p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <span>{matter.title}</span><span dir="ltr" className="text-xs opacity-60">{matter.kind} · {matter.asOf}</span>
              </Link>
            </li>
          ))}
          {matters.length === 0 && <li className="p-3 text-sm opacity-70">{t('No matters yet')}</li>}
        </ul>
      </section>
    </main>
  );
}
