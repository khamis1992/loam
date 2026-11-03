'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { legalApi, type MatterWorkItem, type MatterWorkKind, type MatterWorkReport, type MatterWorkStatus } from '@/services/legalApi';

const kinds: MatterWorkKind[] = ['task', 'deadline', 'hearing', 'filing'];
const statuses: MatterWorkStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];

export function LegalWorkItems({ matterId }: { matterId: string }) {
  const [items, setItems] = useState<MatterWorkItem[]>([]);
  const [report, setReport] = useState<MatterWorkReport | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<MatterWorkKind>('task');
  const [dueAt, setDueAt] = useState('');
  const [assignee, setAssignee] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, summary] = await Promise.all([legalApi.listWorkItems(matterId), legalApi.getMatterReport(matterId)]);
      setItems(list.items);
      setReport(summary.report);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [matterId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => act(async () => {
    await legalApi.addWorkItem(matterId, { title, kind, status: 'pending', dueAt: dueAt || null, assignee: assignee || null, notes: notes || null });
    setTitle(''); setDueAt(''); setAssignee(''); setNotes('');
  });

  return (
    <section className="space-y-4" aria-label={t('Work items')}>
      <header><h2 className="text-lg font-semibold">{t('Office work')}</h2><p className="text-xs opacity-70">{t('Tasks, deadlines, hearings and filings for this matter')}</p></header>
      {report && <div role="status" className="grid grid-cols-2 gap-2 rounded-md border p-3 text-center sm:grid-cols-4">
        <p><strong>{report.overdue}</strong><span className="block text-xs">{t('Overdue')}</span></p>
        <p><strong>{report.inProgress}</strong><span className="block text-xs">{t('In progress')}</span></p>
        <p><strong>{report.done}</strong><span className="block text-xs">{t('Completed')}</span></p>
        <p><strong dir="ltr">{report.nextDueAt ?? '—'}</strong><span className="block text-xs">{t('Next due')}</span></p>
      </div>}
      <form className="grid gap-2 rounded-md border p-3 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label className="text-xs md:col-span-2">{t('Work item title')}<input required dir="auto" value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 w-full rounded border p-2" /></label>
        <label className="text-xs">{t('Work item type')}<select value={kind} onChange={(event) => setKind(event.target.value as MatterWorkKind)} className="mt-1 w-full rounded border p-2">{kinds.map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <label className="text-xs">{t('Due date')}<input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className="mt-1 w-full rounded border p-2" /></label>
        <label className="text-xs md:col-span-2">{t('Assignee')}<input dir="auto" value={assignee} onChange={(event) => setAssignee(event.target.value)} className="mt-1 w-full rounded border p-2" /></label>
        <label className="text-xs md:col-span-2">{t('Notes')}<textarea dir="auto" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} className="mt-1 w-full rounded border p-2" /></label>
        <button type="submit" disabled={busy || !title.trim()} className="rounded border px-3 py-2 disabled:opacity-50 md:col-span-2">{busy ? t('Saving') : t('Add work item')}</button>
      </form>
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      <ul className="space-y-2">
        {items.map((item) => <li key={item.id} className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="font-semibold">{item.title}</h3><p className="text-xs opacity-70">{t(item.kind)}{item.dueAt ? ` · ${item.dueAt}` : ''}{item.assignee ? ` · ${item.assignee}` : ''}</p></div>
            <button type="button" disabled={busy} onClick={() => void act(() => legalApi.deleteWorkItem(matterId, item.id))} className="rounded border px-2 py-1 text-xs">{t('Delete work item')}</button>
          </div>
          {item.notes && <p dir="auto" className="whitespace-pre-wrap text-xs">{item.notes}</p>}
          <label className="block text-xs">{t('Status')}<select aria-label={`${t('Status')}: ${item.title}`} value={item.status} disabled={busy} onChange={(event) => void act(() => legalApi.updateWorkItem(matterId, item.id, { status: event.target.value as MatterWorkStatus }))} className="mt-1 rounded border p-1">{statuses.map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        </li>)}
        {items.length === 0 && <li className="rounded-md border p-3 opacity-70">{t('No work items yet')}</li>}
      </ul>
    </section>
  );
}
