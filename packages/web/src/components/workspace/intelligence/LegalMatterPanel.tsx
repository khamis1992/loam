'use client';

import { useEffect, useState } from 'react';
import { BriefcaseBusiness, ChevronDown, ChevronUp, Link2, Search, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { WorkspaceFile } from '../types';
import { attachCurrentArtifact, createMatter, getMatterConflicts, getMatterDashboard, listMatters, searchMatterArchive, searchOfficialSources, type LegalSource, type Matter, type MatterDashboard } from './officeLegalApi';
import type { SourceAnchor } from './officeIntelligenceApi';

export default function LegalMatterPanel({ file }: { file: WorkspaceFile }) {
  const [open, setOpen] = useState(false);
  const [matters, setMatters] = useState<Matter[]>([]);
  const [selected, setSelected] = useState<Matter | null>(null);
  const [dashboard, setDashboard] = useState<MatterDashboard | null>(null);
  const [title, setTitle] = useState('');
  const [client, setClient] = useState('');
  const [query, setQuery] = useState('');
  const [archive, setArchive] = useState<Array<{ matterId: string; source: SourceAnchor }>>([]);
  const [sources, setSources] = useState<LegalSource[]>([]);
  const [conflicts, setConflicts] = useState<Array<{ matterId: string; client: string; matchedParty: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void listMatters().then((items) => {
      setMatters(items);
      setSelected((current) => current ?? items[0] ?? null);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [open]);

  useEffect(() => {
    if (!selected) { setDashboard(null); return; }
    void getMatterDashboard(selected.id).then(setDashboard).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [selected]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <section className="border-t border-border-main bg-bg-menu text-text-primary" aria-label="ملف القضية">
    <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-sm hover:bg-fill-hover" aria-expanded={open}>
      <BriefcaseBusiness className="size-4 text-brand" /><span className="font-medium">ملف القضية والمعرفة القانونية</span><span className="flex-1" />{open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
    </button>
    {open ? <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto border-t border-border-light p-3">
      {error ? <p role="alert" className="text-sm text-func-error">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <input aria-label="اسم القضية" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="اسم القضية" className="min-w-36 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
        <input aria-label="العميل" value={client} onChange={(event) => setClient(event.target.value)} placeholder="العميل" className="min-w-36 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
        <Button size="sm" disabled={!title.trim() || !client.trim()} loading={busy} onClick={() => run(async () => {
          const matter = await createMatter(title.trim(), client.trim());
          setMatters((items) => [matter, ...items]); setSelected(matter); setTitle(''); setClient('');
        })}>إنشاء قضية</Button>
      </div>
      {matters.length ? <div className="flex flex-wrap items-center gap-2">
        <select aria-label="اختيار القضية" value={selected?.id ?? ''} onChange={(event) => setSelected(matters.find((matter) => matter.id === event.target.value) ?? null)} className="min-h-9 min-w-52 flex-1 rounded-control border border-border-main bg-bg-main px-2 text-sm">
          {matters.map((matter) => <option key={matter.id} value={matter.id}>{matter.title} — {matter.client}</option>)}
        </select>
        <Button size="sm" variant="secondary" disabled={!selected} loading={busy} onClick={() => run(async () => {
          if (!selected) return;
          const updated = await attachCurrentArtifact(selected, file);
          setSelected(updated); setMatters((items) => items.map((item) => item.id === updated.id ? updated : item));
          setDashboard(await getMatterDashboard(updated.id));
        })}><Link2 className="size-4" />إرفاق المستند</Button>
        <Button size="sm" variant="ghost" disabled={!selected} loading={busy} onClick={() => run(async () => {
          if (selected) setConflicts(await getMatterConflicts(selected.id));
        })}><ShieldAlert className="size-4" />فحص التعارض</Button>
      </div> : null}
      {dashboard ? <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <span className="rounded-control bg-bg-main p-2">مهام مفتوحة: {dashboard.openTasks}</span>
        <span className="rounded-control bg-bg-main p-2">مواعيد متأخرة: {dashboard.overdueDeadlines.length}</span>
        <span className="rounded-control bg-bg-main p-2">مواعيد قادمة: {dashboard.upcomingDeadlines.length}</span>
        <span className="rounded-control bg-bg-main p-2">مرفقات: {dashboard.artifacts}</span>
        <span className="rounded-control bg-bg-main p-2">أحداث: {dashboard.events}</span>
      </div> : null}
      {conflicts.length ? <div className="rounded-control border border-func-warning p-2 text-xs"><p className="font-medium">مرشحون يحتاجون مراجعة بشرية، وليسوا قرار تعارض نهائيًا:</p>{conflicts.map((item) => <p key={`${item.matterId}-${item.matchedParty}`}>{item.client} — {item.matchedParty}</p>)}</div> : null}
      <div className="flex gap-2">
        <input aria-label="بحث قانوني" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث في المصادر الرسمية وأرشيف القضايا" className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm" />
        <Button size="sm" disabled={!query.trim()} loading={busy} onClick={() => run(async () => {
          const [official, attached] = await Promise.all([searchOfficialSources(query.trim()), searchMatterArchive(query.trim())]);
          setSources(official); setArchive(attached);
        })}><Search className="size-4" />بحث</Button>
      </div>
      {sources.length ? <div className="flex flex-col gap-2 text-xs"><p className="font-medium">المصادر الرسمية</p>{sources.map((source) => <article key={source.id} className="rounded-control bg-bg-main p-2"><p className="font-medium">{source.title} — {source.citation}</p><p className="text-text-secondary">{source.issuer} • ساري من {source.effectiveFrom}</p><p className="mt-1 whitespace-pre-wrap">{source.text.slice(0, 600)}</p><a href={source.sourceUrl} target="_blank" rel="noreferrer" className="text-brand underline">المصدر الرسمي</a></article>)}</div> : null}
      {archive.length ? <div className="flex flex-col gap-2 text-xs"><p className="font-medium">نتائج الأرشيف</p>{archive.map((result) => <article key={`${result.matterId}-${result.source.id}`} className="rounded-control bg-bg-main p-2"><p className="text-text-tertiary">{result.matterId} • {result.source.kind}:{result.source.anchor}</p><p>{result.source.excerpt}</p></article>)}</div> : null}
    </div> : null}
  </section>;
}
