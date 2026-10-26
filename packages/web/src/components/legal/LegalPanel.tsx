'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { activeLegalMatterId, legalApi, setActiveLegalMatterId, type LegalSearchResult, type LegalStatus, type Matter, type StructureIssue, type VerificationReport } from '@/services/legalApi';
import { CitationBadge } from './CitationBadge';
import { MatterPrivacy } from './MatterPrivacy';
import { VerificationReportView } from './VerificationReportView';

type Tab = 'search' | 'verify' | 'matters';

/** Legal mode side panel: corpus search, citation verification, matters. RTL by default. */
export function LegalPanel() {
  const [tab, setTab] = useState<Tab>('search');
  const [status, setStatus] = useState<LegalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { legalApi.status().then(setStatus).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, []);
  return (
    <div dir="rtl" lang="ar" className="flex h-full flex-col gap-3 p-3 text-sm" style={{ fontFamily: "'Noto Naskh Arabic', 'Sakkal Majalla', 'Segoe UI', serif" }}>
      <header className="space-y-1">
        <h2 className="text-base font-semibold">{t('Qatari law')}</h2>
        {status && (
          <p className="text-xs opacity-75">
            {t('{n} laws · {m} articles · today {date} (Asia/Qatar)', { n: status.corpus.legislations, m: status.corpus.articles, date: status.today })}
            {!status.localModelApproved && <span className="ms-2 text-red-700 dark:text-red-300">{t('Local model is not approved: client text is blocked')}</span>}
            {!status.keyAvailable && <span className="ms-2 text-red-700 dark:text-red-300">{t('Matters are locked (encryption key unavailable)')}</span>}
          </p>
        )}
        {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      </header>
      <div role="tablist" className="flex gap-1">
        {(['search', 'verify', 'matters'] as const).map((id) => (
          <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)}
            className={`rounded-md border px-3 py-1 ${tab === id ? 'bg-zinc-100 font-semibold dark:bg-zinc-800' : ''}`}>
            {t(id === 'search' ? 'Search' : id === 'verify' ? 'Verify draft' : 'Matters')}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {tab === 'search' && <SearchTab today={status?.today ?? ''} />}
        {tab === 'verify' && <VerifyTab />}
        {tab === 'matters' && <MattersTab />}
      </div>
    </div>
  );
}

function SearchTab({ today }: { today: string }) {
  const [q, setQ] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [result, setResult] = useState<LegalSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try { setResult(await legalApi.search(q, asOf ? { asOf } : {})); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('e.g. compensation for harm, or Article 171 of the Civil Law')} className="min-w-0 flex-1 rounded-md border px-2 py-1" />
        <label className="flex items-center gap-1">{t('As of')}<input type="date" dir="ltr" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="rounded-md border px-2 py-1" /></label>
        <button type="submit" disabled={busy} className="rounded-md border px-3 py-1">{t('Search')}</button>
      </form>
      {result?.noAuthority && <p className="rounded-md bg-zinc-100 p-2 dark:bg-zinc-900">{t('No article in the verified corpus matches. Nothing may be cited for this point.')}</p>}
      <ul className="space-y-3">
        {result?.hits.map((h) => (
          <li key={h.avid} className="space-y-1 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{t('Article {label}', { label: h.label })}</span>
              <span className="opacity-75">{h.legTitle}</span>
              <CitationBadge state={!h.citable ? 'failed' : h.status === 'in_force' ? 'verified' : 'historical'} title={h.provenance} />
            </div>
            <p className="text-xs opacity-70" dir="ltr">{h.effectiveFrom} → {h.effectiveTo ?? t('in force')} · {h.avid}</p>
            <blockquote className="whitespace-pre-wrap border-s-4 ps-3 leading-7">{h.text}</blockquote>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerifyTab() {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'' | 'defense_memo' | 'opinion' | 'contract_report'>('');
  const [out, setOut] = useState<{ report: VerificationReport; structure: StructureIssue[] } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <textarea dir="auto" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Paste a draft with ⟦cite:…⟧ tokens')} className="w-full rounded-md border p-2 leading-7" />
      <div className="flex flex-wrap gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="rounded-md border px-2 py-1">
          <option value="">{t('Citations only')}</option>
          <option value="defense_memo">{t('Defense memorandum')}</option>
          <option value="opinion">{t('Legal opinion')}</option>
          <option value="contract_report">{t('Contract review report')}</option>
        </select>
        <button type="button" disabled={busy || !text.trim()} className="rounded-md border px-3 py-1"
          onClick={async () => { setBusy(true); try { setOut(await legalApi.verify({ text, ...(kind ? { kind } : {}) })); } finally { setBusy(false); } }}>
          {t('Verify')}
        </button>
      </div>
      {out && <VerificationReportView report={out.report} structure={out.structure} />}
    </div>
  );
}

function MattersTab() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Matter['kind']>('defense_memo');
  const [selected, setSelected] = useState<Matter | null>(null);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => { setActive(activeLegalMatterId()); }, []);
  const choose = (id: string | null) => { setActiveLegalMatterId(id); setActive(id); };
  const refresh = useCallback(() => { void legalApi.listMatters().then((r) => setMatters(r.matters)); }, []);
  useEffect(refresh, [refresh]);
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); if (!title.trim()) return; await legalApi.createMatter({ title, kind }); setTitle(''); refresh(); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('Matter title')} className="min-w-0 flex-1 rounded-md border px-2 py-1" />
        <select value={kind} onChange={(e) => setKind(e.target.value as Matter['kind'])} className="rounded-md border px-2 py-1">
          <option value="defense_memo">{t('Defense memorandum')}</option>
          <option value="contract_review">{t('Contract review')}</option>
          <option value="opinion">{t('Legal opinion')}</option>
          <option value="research">{t('Research')}</option>
        </select>
        <button type="submit" className="rounded-md border px-3 py-1">{t('New matter')}</button>
      </form>
      <ul className="divide-y rounded-lg border">
        {matters.map((m) => (
          <li key={m.id} className="flex items-center gap-2 pe-2">
            <button type="button" onClick={() => setSelected(m)} className="flex min-w-0 flex-1 justify-between px-3 py-2 text-start">
              <span>{m.title}</span>
              <span className="text-xs opacity-70">{t(m.egress === 'local_only' ? 'Local only' : 'Cloud allowed')} · {m.asOf}</span>
            </button>
            {active === m.id
              ? <button type="button" onClick={() => choose(null)} className="rounded-md border border-emerald-600/50 px-2 py-0.5 text-xs">{t('Active in Legal chats')}</button>
              : <button type="button" onClick={() => choose(m.id)} className="rounded-md border px-2 py-0.5 text-xs">{t('Use in Legal chats')}</button>}
          </li>
        ))}
      </ul>
      {selected && <MatterPrivacy matter={selected} onChange={(m) => { setSelected(m); refresh(); }} />}
    </div>
  );
}
