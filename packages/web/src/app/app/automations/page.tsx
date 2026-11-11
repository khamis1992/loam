'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowUp,
  CalendarClock,
  Check,
  Clock,
  Copy,
  GitPullRequest,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  SlidersHorizontal,
  Trash2,
  Webhook,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { getLocale, t } from '@/i18n/t';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
  type Schedule,
  type ScheduleDraft,
} from '@/services/schedulesApi';
import { Dialog } from '@/components/ui/Dialog';
import { getApiBase } from '@/services/rpc';

type DraftKind = 'interval' | 'cron' | 'once' | 'webhook' | 'github' | 'advanced';
type CreateView = 'schedule' | 'trigger' | 'advanced';
type StatusFilter = 'all' | 'active' | 'paused';

interface Draft {
  id?: string;
  prompt: string;
  kind: DraftKind;
  intervalSeconds: string;
  cron: string;
  at: string;
  webhookSecret: string;
  githubEvents: string;
}

const SUGGESTIONS = [
  { title: 'Log invoices automatically', event: 'A new invoice or receipt arrives', action: 'Log the details in Sheets and save attachments to Drive.', prompt: 'When an invoice or receipt arrives, log the details in a spreadsheet and save the attachment to a Drive folder.', kind: 'webhook' as const },
  { title: 'Recover trust after a refund', event: 'A customer receives a refund', action: 'Review the refund and draft a thoughtful follow-up.', prompt: 'When a customer receives a refund, review the order and draft a thoughtful follow-up message.', kind: 'webhook' as const },
  { title: 'Spot the winning ad early', event: 'Campaign performance metrics are updated', action: 'Find winning ads and recommend the next tests.', prompt: 'When campaign performance metrics are updated, find the winning ads and recommend the next tests.', kind: 'advanced' as const },
];

function scheduleLabel(s: Schedule): string {
  if (s.trigger === 'webhook') return t('On webhook event');
  if (s.trigger === 'github') return s.githubEvents?.length ? s.githubEvents.join(', ') : t('On GitHub event');
  if (s.cron) return s.cron;
  if (s.runAt) return `${t('Once at')} ${formatDateTime(s.runAt)}`;
  const seconds = s.intervalSeconds || 0;
  if (seconds % 86400 === 0 && seconds > 0) return `${t('Every')} ${seconds / 86400} ${t('d')}`;
  if (seconds % 3600 === 0 && seconds > 0) return `${t('Every')} ${seconds / 3600} ${t('h')}`;
  if (seconds % 60 === 0 && seconds > 0) return `${t('Every')} ${seconds / 60} ${t('min')}`;
  return `${t('Every')} ${seconds} ${t('s')}`;
}

function triggerLabel(s: Schedule): string {
  if (s.trigger === 'webhook') return t('Webhook');
  if (s.trigger === 'github') return t('GitHub');
  if (s.playbook) return t('Advanced automation');
  return t('Schedule');
}

function formatDateTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(getLocale() === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}

function updateSummary(s: Schedule): string {
  if (s.lastStatus === 'failed') return s.lastError || t('The automation run failed.');
  if (s.lastStatus === 'retrying') return t('The automation will retry shortly.');
  return t('The automation run completed successfully.');
}

function newSecret(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export default function AutomationsPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'updates' | 'manage'>('updates');
  const [createView, setCreateView] = useState<CreateView | null>(null);
  const [createMenu, setCreateMenu] = useState(false);
  const [filterMenu, setFilterMenu] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [updatesView, setUpdatesView] = useState<'list' | 'grid'>('list');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly' | 'hourly'>('daily');
  const [time, setTime] = useState('10:00');
  const [webhookSetup, setWebhookSetup] = useState<{ id: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await listSchedules();
      setSchedules(data.schedules ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // eslint-disable-next-line no-console
      console.error('failed to load automations', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    listSchedules()
      .then((data) => { if (mounted) { setSchedules(data.schedules ?? []); setError(null); } })
      .catch((e) => { if (mounted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const openCreate = (view: CreateView) => {
    setCreateMenu(false);
    setFormError(null);
    setCreateView(view);
  };

  const openNew = (prompt = '', kind: DraftKind = 'webhook') => {
    setFormError(null);
    setDraft({ prompt, kind, intervalSeconds: '3600', cron: kind === 'cron' ? '0 9 * * *' : '', at: '', webhookSecret: newSecret(), githubEvents: 'pull_request.opened' });
  };

  const createScheduled = async (event: FormEvent) => {
    event.preventDefault();
    if (!newPrompt.trim() || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const [hour, minute] = time.split(':').map(Number);
      const body: ScheduleDraft = { prompt: newPrompt.trim() };
      if (cadence === 'hourly') body.intervalSeconds = 3600;
      if (cadence === 'daily') body.cron = `${minute} ${hour} * * *`;
      if (cadence === 'weekly') body.cron = `${minute} ${hour} * * 1`;
      if (cadence === 'monthly') body.cron = `${minute} ${hour} 1 * *`;
      await createSchedule(body);
      setNewPrompt('');
      setCreateView(null);
      setTab('manage');
      await refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !draft.prompt.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      if (draft.id) {
        await updateSchedule(draft.id, { prompt: draft.prompt.trim() });
      } else {
        const body: ScheduleDraft = { prompt: draft.prompt.trim() };
        if (draft.kind === 'interval' || draft.kind === 'advanced') body.intervalSeconds = Number(draft.intervalSeconds) || 3600;
        if (draft.kind === 'cron') body.cron = draft.cron.trim();
        if (draft.kind === 'once') body.at = new Date(draft.at).toISOString();
        if (draft.kind === 'advanced') body.playbook = draft.prompt.trim();
        if (draft.kind === 'webhook' || draft.kind === 'github') {
          body.trigger = draft.kind;
          body.webhookSecret = draft.webhookSecret.trim();
          if (!body.webhookSecret) throw new Error(t('Webhook secret is required'));
        }
        if (draft.kind === 'github') {
          body.githubEvents = draft.githubEvents.split(',').map((item) => item.trim()).filter(Boolean);
          if (body.githubEvents.length === 0) throw new Error(t('At least one GitHub event is required'));
        }
        const result = await createSchedule(body);
        if ((draft.kind === 'webhook' || draft.kind === 'github') && result.schedule?.id) {
          setWebhookSetup({ id: result.schedule.id, secret: draft.webhookSecret.trim() });
          setCopied(false);
        }
      }
      setDraft(null);
      setNewPrompt('');
      setCreateView(null);
      setTab('manage');
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (s: Schedule) => {
    setBusyId(s.id);
    try {
      await updateSchedule(s.id, { enabled: !s.enabled });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (s: Schedule) => {
    setBusyId(s.id);
    try {
      await runScheduleNow(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await deleteSchedule(id);
      setConfirmDelete(null);
      setMenuId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const copySetup = async (value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
  };

  const updates = useMemo(() => schedules
    .filter((s) => s.lastRunAt)
    .sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '')), [schedules]);
  const updateGroups = useMemo(() => {
    const groups = new Map<string, Schedule[]>();
    for (const schedule of updates) {
      const key = schedule.lastRunAt!.slice(0, 10);
      groups.set(key, [...(groups.get(key) ?? []), schedule]);
    }
    return [...groups.entries()];
  }, [updates]);
  const managed = useMemo(() => schedules.filter((s) => statusFilter === 'all' || (statusFilter === 'active' ? s.enabled : !s.enabled)), [schedules, statusFilter]);
  const webhookUrl = webhookSetup ? `${getApiBase()}/api/automations/trigger/${encodeURIComponent(webhookSetup.id)}` : '';

  if (createView === 'schedule') {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-main">
        <header className="flex h-14 shrink-0 items-center px-6"><h1 className="text-[18px] font-semibold text-text-primary">{t('Automations')}</h1></header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12">
          <main className="mx-auto w-full max-w-[768px]">
            <h2 className="pt-14 text-center font-serif text-[34px] leading-tight text-text-primary">{t('Automate your work')}</h2>
            <form onSubmit={(event) => void createScheduled(event)} className="mt-16 rounded-card border border-border-main bg-bg-menu p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-text-primary">{t('When')}</h3>
                <button type="button" aria-label={t('Close')} onClick={() => setCreateView(null)} className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover"><X className="size-4" /></button>
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-[8px] border border-border-main p-3">
                <Clock className="size-4 text-text-secondary" />
                <label className="text-sm text-text-secondary"><span className="sr-only">{t('Cadence')}</span><select aria-label={t('Cadence')} value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} className="bg-transparent text-text-primary outline-none"><option value="daily">{t('Daily')}</option><option value="weekly">{t('Weekly')}</option><option value="monthly">{t('Monthly')}</option><option value="hourly">{t('Hourly')}</option></select></label>
                {cadence !== 'hourly' && <><span className="text-sm text-text-tertiary">{t('at')}</span><input aria-label={t('Time')} type="time" value={time} onChange={(e) => setTime(e.target.value)} className="bg-transparent text-sm text-text-primary outline-none" /></>}
              </div>
              <h3 className="mt-5 text-sm font-medium text-text-primary">{t('Loam will')}</h3>
              <textarea value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} placeholder={t('Describe what Loam should do, e.g. summarize the latest AI news and send me the highlights')} rows={4} className="mt-3 w-full resize-none rounded-[8px] border border-border-main bg-transparent p-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-dark" />
              {formError && <p role="alert" className="mt-2 text-xs text-func-error">{formError}</p>}
              <div className="mt-2 flex justify-end"><button type="submit" disabled={!newPrompt.trim() || saving} className="flex items-center gap-2 rounded-[7px] bg-text-primary px-4 py-2 text-[13px] font-medium text-text-onblack disabled:opacity-40">{saving && <Loader2 className="size-4 animate-spin" />}{t('Create')}</button></div>
            </form>
          </main>
        </div>
      </div>
    );
  }

  if (createView === 'trigger' || createView === 'advanced') {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-main">
        <header className="flex h-14 shrink-0 items-center px-6"><h1 className="text-[18px] font-semibold text-text-primary">{t('Automations')}</h1></header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12">
          <main className="mx-auto w-full max-w-[768px]">
            <h2 className="pt-14 text-center font-serif text-[34px] leading-tight text-text-primary">{t('Automate your work')}</h2>
            <div className="mt-8 rounded-composer border border-border-main bg-bg-menu p-3 shadow-sm">
              <label htmlFor="automation-brief" className="sr-only">{t('Give Loam a task to work on')}</label>
              <textarea id="automation-brief" value={newPrompt} onChange={(event) => setNewPrompt(event.target.value)} placeholder={t('Give Loam a task to work on')} rows={2} data-testid="automation-brief" className="w-full resize-none bg-transparent px-1 py-1 text-sm text-text-primary outline-none placeholder:text-text-tertiary" />
              <div className="flex justify-end"><button type="button" onClick={() => openNew(newPrompt, createView === 'advanced' ? 'advanced' : 'webhook')} aria-label={t('Send')} className="rounded-full bg-text-primary p-2 text-text-onblack hover:opacity-90"><ArrowUp className="size-4" /></button></div>
            </div>
            <section className="mt-4 rounded-card border border-border-main bg-bg-menu p-4" aria-labelledby="automation-start-title">
              <div className="flex items-center justify-between"><h3 id="automation-start-title" className="text-sm font-medium text-text-primary">{t('Choose how it starts')}</h3><button type="button" aria-label={t('Close')} onClick={() => setCreateView(null)} className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover"><X className="size-4" /></button></div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <button type="button" data-testid="automation-kind-schedule" onClick={() => setCreateView('schedule')} className="rounded-[9px] border border-border-main p-3 text-start hover:bg-fill-hover"><CalendarClock className="mb-4 size-4 text-text-secondary" /><span className="block text-[13px] font-medium text-text-primary">{t('Schedule')}</span><span className="mt-1 block text-[11px] text-text-tertiary">{t('Run at a time you choose')}</span></button>
                <button type="button" data-testid="automation-kind-triggered" onClick={() => openNew(newPrompt, 'webhook')} className="rounded-[9px] border border-border-main p-3 text-start hover:bg-fill-hover"><GitPullRequest className="mb-4 size-4 text-text-secondary" /><span className="block text-[13px] font-medium text-text-primary">{t('Triggered task')}</span><span className="mt-1 block text-[11px] text-text-tertiary">{t('Start from activity in your apps')}</span></button>
                <button type="button" data-testid="automation-kind-advanced" onClick={() => openNew(newPrompt, 'advanced')} className="rounded-[9px] border border-border-main p-3 text-start hover:bg-fill-hover"><Workflow className="mb-4 size-4 text-text-secondary" /><span className="block text-[13px] font-medium text-text-primary">{t('Advanced automation')} <span className="rounded bg-fill-tsp px-1 text-[9px] font-normal text-text-tertiary">Beta</span></span><span className="mt-1 block text-[11px] text-text-tertiary">{t('Describe when Loam should act')}</span></button>
              </div>
            </section>
            <section className="mt-6" aria-labelledby="automation-suggestions-title">
              <h3 id="automation-suggestions-title" className="text-sm font-medium text-text-primary">{t('Suggestions')}</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion.title} type="button" onClick={() => { setNewPrompt(suggestion.prompt); if (suggestion.kind === 'advanced') setCreateView('advanced'); }} className="flex min-h-[190px] flex-col rounded-card bg-fill-tsp p-3 text-start transition-colors hover:bg-fill-hover">
                    <span className="rounded-[7px] bg-bg-menu p-2 text-[11px] text-text-secondary">{suggestion.event}</span><ArrowUp className="my-1 size-3 self-center rotate-180 text-text-tertiary" /><span className="rounded-[7px] bg-bg-menu p-2 text-[11px] leading-4 text-text-secondary">{suggestion.action}</span><span className="mt-auto pt-3 text-[12px] font-medium text-text-primary">{suggestion.title}</span>
                  </button>
                ))}
              </div>
            </section>
          </main>
        </div>
        <AutomationDraftDialog draft={draft} setDraft={setDraft} saving={saving} formError={formError} onSubmit={saveDraft} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-main">
      <header className="flex h-14 shrink-0 items-center justify-between px-6">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-text-primary">{t('Automations')}</h1>
        <div className="flex items-center gap-2">
          {tab === 'updates' && <div className="flex items-center rounded-[6px] bg-fill-tsp p-0.5"><button type="button" aria-label={t('List view')} aria-pressed={updatesView === 'list'} onClick={() => setUpdatesView('list')} className={clsx('rounded-[5px] p-1.5', updatesView === 'list' ? 'bg-bg-menu text-text-primary shadow-sm' : 'text-text-tertiary')}><List className="size-4" /></button><button type="button" aria-label={t('Grid view')} aria-pressed={updatesView === 'grid'} onClick={() => setUpdatesView('grid')} className={clsx('rounded-[5px] p-1.5', updatesView === 'grid' ? 'bg-bg-menu text-text-primary shadow-sm' : 'text-text-tertiary')}><LayoutGrid className="size-4" /></button></div>}
          <div className="relative">
            <button type="button" aria-label={t('Filter')} onClick={() => { setFilterMenu((value) => !value); setCreateMenu(false); }} className="rounded-[6px] p-2 text-text-secondary hover:bg-fill-hover"><SlidersHorizontal className="size-4" /></button>
            {filterMenu && <div role="menu" className="absolute end-0 top-10 z-30 w-40 rounded-card border border-border-main bg-bg-menu p-1.5 shadow-layer">{(['all', 'active', 'paused'] as const).map((filter) => <button key={filter} role="menuitemradio" aria-checked={statusFilter === filter} onClick={() => { setStatusFilter(filter); setFilterMenu(false); }} className={clsx('w-full rounded-control px-3 py-2 text-start text-xs hover:bg-fill-hover', statusFilter === filter ? 'font-medium text-text-primary' : 'text-text-secondary')}>{t(filter === 'all' ? 'All automations' : filter === 'active' ? 'Active' : 'Paused')}</button>)}</div>}
          </div>
          <div className="relative">
            <button type="button" onClick={() => { setCreateMenu((value) => !value); setFilterMenu(false); }} className="flex items-center gap-1.5 rounded-[7px] bg-text-primary px-3.5 py-2 text-[13px] font-medium text-text-onblack hover:opacity-90"><Plus className="size-4" />{t('Create')}</button>
            {createMenu && <div role="menu" className="absolute end-0 top-11 z-30 w-64 rounded-card border border-border-main bg-bg-menu p-2 shadow-layer"><button role="menuitem" onClick={() => openCreate('schedule')} className="flex w-full items-center gap-2 rounded-control px-3 py-2.5 text-start text-[13px] text-text-primary hover:bg-fill-hover"><Clock className="size-4 text-text-secondary" />{t('Schedule')}</button><button role="menuitem" onClick={() => openCreate('trigger')} className="flex w-full items-center gap-2 rounded-control px-3 py-2.5 text-start text-[13px] text-text-primary hover:bg-fill-hover"><GitPullRequest className="size-4 text-text-secondary" />{t('Trigger')}</button><button role="menuitem" onClick={() => openCreate('advanced')} className="flex w-full items-center gap-2 rounded-control px-3 py-2.5 text-start text-[13px] text-text-primary hover:bg-fill-hover"><Workflow className="size-4 text-text-secondary" /><span>{t('Advanced automation')}</span><span className="rounded bg-fill-tsp px-1.5 py-0.5 text-[9px] text-text-tertiary">Beta</span></button></div>}
          </div>
        </div>
      </header>
      <div className="flex h-10 shrink-0 items-end gap-6 border-b border-border-main px-6" role="tablist" aria-label={t('Automation views')}>
        {(['updates', 'manage'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={clsx('h-full border-b-2 text-[13px]', tab === item ? 'border-text-primary font-medium text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-primary')}>{t(item === 'updates' ? 'Updates' : 'Manage')}</button>)}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {loading ? <div className="flex items-center justify-center gap-2 py-16 text-text-secondary"><Loader2 className="size-5 animate-spin" />{t('Loading')}</div> : error && schedules.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-func-error" role="alert"><AlertCircle className="size-6" /><p className="text-sm">{t('Failed to load automations')}</p><p className="text-xs">{error}</p><button type="button" onClick={() => { setLoading(true); void refresh(); }} className="mt-2 rounded-[6px] bg-fill-hover px-3 py-1.5 text-xs text-text-primary">{t('Retry')}</button></div>
        ) : tab === 'updates' ? (
          updates.length === 0 ? <div className="flex flex-col items-center gap-3 py-16 text-text-tertiary"><Zap className="size-8 stroke-[1.25]" /><p className="text-sm">{t('No automation updates yet.')}</p><button type="button" onClick={() => setCreateMenu(true)} className="flex items-center gap-1 rounded-[7px] bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"><Plus className="size-4" />{t('Create your first automation')}</button></div> : (
            <div className="mx-auto w-full max-w-[960px]">
              {updateGroups.map(([date, items]) => (
                <section key={date} className="mb-5">
                  <h2 className="mb-2 text-sm font-medium text-text-primary">{new Intl.DateTimeFormat(getLocale() === 'ar' ? 'ar' : 'en', { month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00`))} ({items.length})</h2>
                  <div className={clsx('grid gap-3', updatesView === 'grid' && 'md:grid-cols-2')}>
                    {items.map((s) => <button key={s.id} type="button" onClick={() => { if (s.lastTaskId) router.push(`/app/${s.lastTaskId}`); }} className="grid overflow-hidden rounded-card border border-border-main bg-bg-menu text-start md:grid-cols-[236px_1fr]"><span className="border-b border-border-light bg-fill-tsp p-4 md:border-b-0 md:border-e"><Clock className="mb-3 size-4 text-text-secondary" /><span className="block text-[13px] font-medium text-text-primary">{s.prompt}</span><span className="mt-2 block text-[11px] text-text-tertiary">{formatDateTime(s.lastRunAt!)}</span></span><span className="p-4 text-[13px] leading-6 text-text-secondary">{updateSummary(s)}</span></button>)}
                  </div>
                </section>
              ))}
            </div>
          )
        ) : (
          <div className="mx-auto w-full max-w-[768px]">
            {webhookSetup && <WebhookSetup id={webhookSetup.id} secret={webhookSetup.secret} url={webhookUrl} copied={copied} onCopy={copySetup} onClose={() => setWebhookSetup(null)} />}
            {managed.length === 0 ? <div className="flex flex-col items-center gap-3 py-16 text-text-tertiary"><Zap className="size-8 stroke-[1.25]" /><p className="text-sm">{schedules.length === 0 ? t('No automations yet.') : t('No automations match this filter.')}</p><button type="button" onClick={() => setCreateMenu(true)} className="flex items-center gap-1 rounded-[7px] bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"><Plus className="size-4" />{t('Create your first automation')}</button></div> : (
              <div className="grid gap-4 md:grid-cols-2">
                {managed.map((s) => (
                  <article key={s.id} className="relative min-w-0 rounded-card border border-border-main bg-bg-menu p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex size-8 items-center justify-center rounded-full border border-border-main">{s.trigger === 'webhook' || s.trigger === 'github' ? <Webhook className="size-4 text-text-secondary" /> : <Clock className="size-4 text-text-secondary" />}</span>
                      <div className="flex items-center gap-2"><span className="flex items-center gap-1.5 text-[11px] text-text-tertiary"><span className={clsx('size-1.5 rounded-full', s.enabled ? 'bg-func-success' : 'bg-text-tertiary')} />{t(s.enabled ? 'Active' : 'Paused')}</span><button type="button" aria-label={t('Automation actions')} onClick={() => setMenuId(menuId === s.id ? null : s.id)} className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover"><MoreHorizontal className="size-4" /></button></div>
                    </div>
                    <p className="mt-3 text-[11px] text-text-tertiary">{triggerLabel(s)} · {scheduleLabel(s)}</p>
                    <h2 className="mt-1 truncate text-[13px] font-medium text-text-primary" title={s.prompt}>{s.prompt}</h2>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-tertiary">{s.playbook || s.prompt}</p>
                    {menuId === s.id && <div className="absolute end-3 top-12 z-20 w-40 rounded-card border border-border-main bg-bg-menu p-1.5 shadow-layer"><button type="button" onClick={() => { setMenuId(null); void runNow(s); }} disabled={busyId === s.id} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-xs text-text-primary hover:bg-fill-hover"><Play className="size-3.5" />{t('Run now')}</button><button type="button" onClick={() => { setMenuId(null); void toggle(s); }} disabled={busyId === s.id} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-xs text-text-primary hover:bg-fill-hover"><Zap className="size-3.5" />{t(s.enabled ? 'Pause' : 'Resume')}</button><button type="button" onClick={() => { setMenuId(null); setFormError(null); setDraft({ id: s.id, prompt: s.prompt, kind: s.trigger === 'webhook' || s.trigger === 'github' ? s.trigger : s.playbook ? 'advanced' : s.cron ? 'cron' : s.runAt ? 'once' : 'interval', intervalSeconds: String(s.intervalSeconds ?? 3600), cron: s.cron ?? '', at: s.runAt ?? '', webhookSecret: newSecret(), githubEvents: s.githubEvents?.join(', ') ?? 'pull_request.opened' }); }} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-xs text-text-primary hover:bg-fill-hover"><Pencil className="size-3.5" />{t('Edit')}</button>{confirmDelete === s.id ? <button type="button" onClick={() => void remove(s.id)} disabled={busyId === s.id} className="w-full rounded-control px-3 py-2 text-start text-xs text-func-error hover:bg-fill-hover">{t('Confirm delete')}</button> : <button type="button" onClick={() => setConfirmDelete(s.id)} className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-xs text-func-error hover:bg-fill-hover"><Trash2 className="size-3.5" />{t('Delete')}</button>}</div>}
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <AutomationDraftDialog draft={draft} setDraft={setDraft} saving={saving} formError={formError} onSubmit={saveDraft} />
    </div>
  );
}

function WebhookSetup({ id, secret, url, copied, onCopy, onClose }: { id: string; secret: string; url: string; copied: boolean; onCopy: (value: string) => Promise<void>; onClose: () => void }) {
  void id;
  return (
    <div className="mb-4 rounded-card border border-border-main bg-bg-menu p-4" role="status">
      <div className="flex items-start gap-3"><Webhook className="mt-0.5 size-4 shrink-0 text-text-secondary" /><div className="min-w-0 flex-1"><h3 className="text-sm font-medium text-text-primary">{t('Webhook setup')}</h3><p className="mt-1 text-xs leading-5 text-text-tertiary">{t('Copy these values now. The secret will not be shown again.')}</p><code dir="ltr" className="mt-3 block overflow-x-auto rounded-[6px] bg-fill-tsp p-2 text-[11px] text-text-secondary">{url}</code><code dir="ltr" className="mt-2 block overflow-x-auto rounded-[6px] bg-fill-tsp p-2 text-[11px] text-text-secondary">{secret}</code><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void onCopy(url)} className="flex items-center gap-1.5 rounded-[6px] bg-fill-hover px-3 py-1.5 text-xs text-text-primary">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{t('Copy webhook URL')}</button><button type="button" onClick={() => void onCopy(secret)} className="flex items-center gap-1.5 rounded-[6px] bg-fill-hover px-3 py-1.5 text-xs text-text-primary"><Copy className="size-3.5" />{t('Copy secret')}</button></div></div><button type="button" aria-label={t('Close')} onClick={onClose} className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover"><X className="size-4" /></button></div>
    </div>
  );
}

function AutomationDraftDialog({ draft, setDraft, saving, formError, onSubmit }: { draft: Draft | null; setDraft: (draft: Draft | null) => void; saving: boolean; formError: string | null; onSubmit: (event: FormEvent) => Promise<void> }) {
  return (
    <Dialog open={draft !== null} onClose={() => setDraft(null)} title={draft?.id ? t('Edit automation') : t('New automation')} width={520}>
      {draft && <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <textarea autoFocus value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder={t('What should {product} do?')} rows={3} className="resize-y rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-dark" />
        {!draft.id && <div className="flex flex-col gap-3">
          {(draft.kind === 'interval' || draft.kind === 'advanced') && <label className="text-xs text-text-secondary">{draft.kind === 'advanced' ? t('Check interval in seconds') : t('Interval in seconds (min 30)')}<input type="number" min={30} value={draft.intervalSeconds} onChange={(e) => setDraft({ ...draft, intervalSeconds: e.target.value })} className="mt-1.5 w-full rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none" /></label>}
          {draft.kind === 'cron' && <input type="text" dir="ltr" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} placeholder="0 9 * * *" className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary" />}
          {draft.kind === 'once' && <input type="datetime-local" value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none" />}
          {(draft.kind === 'webhook' || draft.kind === 'github') && <>
            <div className="flex gap-1 rounded-card bg-fill-tsp p-1" role="group" aria-label={t('Trigger source')}>{(['webhook', 'github'] as const).map((kind) => <button key={kind} type="button" aria-pressed={draft.kind === kind} onClick={() => setDraft({ ...draft, kind })} className={clsx('flex-1 rounded-control px-2 py-1.5 text-xs font-medium', draft.kind === kind ? 'bg-bg-menu text-text-primary shadow-sm' : 'text-text-tertiary')}>{t(kind === 'webhook' ? 'Webhook' : 'GitHub')}</button>)}</div>
            {draft.kind === 'github' && <label className="text-xs text-text-secondary">{t('GitHub events (comma separated)')}<input type="text" dir="ltr" value={draft.githubEvents} onChange={(e) => setDraft({ ...draft, githubEvents: e.target.value })} placeholder="pull_request.opened, issues.opened" className="mt-1.5 w-full rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary" /></label>}
            <label className="text-xs text-text-secondary">{t('Webhook secret')}<input type="text" dir="ltr" autoComplete="off" spellCheck={false} value={draft.webhookSecret} onChange={(e) => setDraft({ ...draft, webhookSecret: e.target.value })} className="mt-1.5 w-full rounded-control border border-border-main bg-bg-main px-3 py-2 font-mono text-xs text-text-primary outline-none" /></label>
            <p className="text-xs leading-5 text-text-tertiary">{t('The endpoint and signing secret will be shown once after creation.')}</p>
          </>}
          {draft.kind === 'advanced' && <p className="text-xs leading-5 text-text-tertiary">{t('Describe the condition and the action. Loam checks the brief at this interval and acts when the condition is met.')}</p>}
        </div>}
        {draft.id && <p className="text-xs text-text-tertiary">{t('The schedule and trigger stay unchanged when editing.')}</p>}
        {formError && <p role="alert" className="text-xs text-func-error">{formError}</p>}
        <div className="flex items-center justify-end gap-2 border-t border-border-main pt-3"><button type="button" onClick={() => setDraft(null)} className="flex items-center gap-1 rounded-control px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover"><X className="size-4" />{t('Cancel')}</button><button type="submit" disabled={saving || !draft.prompt.trim()} className="flex items-center gap-1 rounded-[7px] bg-text-primary px-4 py-2 text-[13px] font-medium text-text-onblack disabled:opacity-40">{saving && <Loader2 className="size-4 animate-spin" />}{t(draft.id ? 'Save' : 'Create')}</button></div>
      </form>}
    </Dialog>
  );
}
