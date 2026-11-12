'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  CirclePause,
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
  Radio,
  SlidersHorizontal,
  Trash2,
  Webhook,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import styles from './automations.module.css';
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

  const activeCount = schedules.filter((schedule) => schedule.enabled).length;
  const pausedCount = schedules.length - activeCount;

  const createMenuContent = createMenu && (
    <div role="menu" className={clsx(styles.menu, styles.createMenu)}>
      <button role="menuitem" onClick={() => openCreate('schedule')} className={styles.menuItem}><Clock className="size-4" />{t('Schedule')}<ArrowUpRight className={styles.menuArrow} /></button>
      <button role="menuitem" onClick={() => openCreate('trigger')} className={styles.menuItem}><GitPullRequest className="size-4" />{t('Trigger')}<ArrowUpRight className={styles.menuArrow} /></button>
      <button role="menuitem" onClick={() => openCreate('advanced')} className={styles.menuItem}><Workflow className="size-4" /><span>{t('Advanced automation')}</span><span className={styles.beta}>Beta</span></button>
    </div>
  );

  if (createView === 'schedule') {
    return (
      <div className={clsx(styles.page, styles.creationPage)}>
        <header className={styles.creationTopbar}>
          <button type="button" onClick={() => setCreateView(null)} className={styles.backButton}><ArrowLeft className={styles.backIcon} />{t('Back')}</button>
          <span>{t('Automations')}</span>
          <span className={styles.creationIndex}>01 / 01</span>
        </header>
        <div className={styles.creationScroll}>
          <main className={styles.creationMain}>
            <div className={styles.creationHeading}>
              <p className={styles.kicker}><Workflow />{t('Loam automation studio')}</p>
              <h1>{t('Automate your work')}</h1>
              <p>{t('Set the trigger. Loam takes it from here.')}</p>
            </div>
            <form onSubmit={(event) => void createScheduled(event)} className={styles.scheduleForm}>
              <section className={styles.formSection}>
                <div className={styles.formSectionTitle}><span>01</span><h2>{t('When')}</h2><Clock /></div>
                <div className={styles.scheduleControls}>
                  <CalendarClock aria-hidden />
                  <label><span className="sr-only">{t('Cadence')}</span><select aria-label={t('Cadence')} value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)}><option value="daily">{t('Daily')}</option><option value="weekly">{t('Weekly')}</option><option value="monthly">{t('Monthly')}</option><option value="hourly">{t('Hourly')}</option></select></label>
                  {cadence !== 'hourly' && <><span>{t('at')}</span><input aria-label={t('Time')} type="time" value={time} onChange={(e) => setTime(e.target.value)} /></>}
                </div>
              </section>
              <section className={styles.formSection}>
                <div className={styles.formSectionTitle}><span>02</span><h2>{t('Loam will')}</h2><Zap /></div>
                <textarea value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} placeholder={t('Describe what Loam should do, e.g. summarize the latest AI news and send me the highlights')} rows={5} className={styles.schedulePrompt} />
              </section>
              {formError && <p role="alert" className={styles.formError}>{formError}</p>}
              <div className={styles.formFooter}><p>{t('Set the trigger. Loam takes it from here.')}</p><button type="submit" disabled={!newPrompt.trim() || saving} className={styles.primaryButton}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{t('Create')}<ArrowUpRight className="size-4" /></button></div>
            </form>
          </main>
        </div>
      </div>
    );
  }

  if (createView === 'trigger' || createView === 'advanced') {
    return (
      <div className={clsx(styles.page, styles.creationPage)}>
        <header className={styles.creationTopbar}>
          <button type="button" onClick={() => setCreateView(null)} className={styles.backButton}><ArrowLeft className={styles.backIcon} />{t('Back')}</button>
          <span>{t('Automations')}</span>
          <span className={styles.creationIndex}>01 / 02</span>
        </header>
        <div className={styles.creationScroll}>
          <main className={styles.creationMain}>
            <div className={styles.creationHeading}>
              <p className={styles.kicker}><Workflow />{t('Loam automation studio')}</p>
              <h1>{t('Automate your work')}</h1>
              <p>{t('Set the trigger. Loam takes it from here.')}</p>
            </div>
            <div className={styles.briefComposer}>
              <label htmlFor="automation-brief"><span>01</span>{t('Give Loam a task to work on')}</label>
              <textarea id="automation-brief" value={newPrompt} onChange={(event) => setNewPrompt(event.target.value)} placeholder={t('Give Loam a task to work on')} rows={3} data-testid="automation-brief" />
              <button type="button" onClick={() => openNew(newPrompt, createView === 'advanced' ? 'advanced' : 'webhook')} aria-label={t('Send')}><ArrowUp /></button>
            </div>
            <section className={styles.startSection} aria-labelledby="automation-start-title">
              <div className={styles.formSectionTitle}><span>02</span><h2 id="automation-start-title">{t('Choose how it starts')}</h2></div>
              <div className={styles.kindGrid}>
                <button type="button" data-testid="automation-kind-schedule" onClick={() => setCreateView('schedule')}><CalendarClock /><span><strong>{t('Schedule')}</strong><small>{t('Run at a time you choose')}</small></span><ArrowUpRight /></button>
                <button type="button" data-testid="automation-kind-triggered" onClick={() => openNew(newPrompt, 'webhook')}><GitPullRequest /><span><strong>{t('Triggered task')}</strong><small>{t('Start from activity in your apps')}</small></span><ArrowUpRight /></button>
                <button type="button" data-testid="automation-kind-advanced" onClick={() => openNew(newPrompt, 'advanced')}><Workflow /><span><strong>{t('Advanced automation')} <em>Beta</em></strong><small>{t('Describe when Loam should act')}</small></span><ArrowUpRight /></button>
              </div>
            </section>
            <section className={styles.suggestions} aria-labelledby="automation-suggestions-title">
              <div className={styles.formSectionTitle}><span>03</span><h2 id="automation-suggestions-title">{t('Suggestions')}</h2></div>
              <div>
                {SUGGESTIONS.map((suggestion, index) => (
                  <button key={suggestion.title} type="button" onClick={() => { setNewPrompt(suggestion.prompt); if (suggestion.kind === 'advanced') setCreateView('advanced'); }}>
                    <span className={styles.suggestionNumber}>0{index + 1}</span>
                    <span className={styles.suggestionCopy}><strong>{suggestion.title}</strong><small>{suggestion.event}</small></span>
                    <ArrowUpRight />
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
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <p className={styles.kicker}><Workflow />{t('Loam automation studio')}<span className={styles.kickerRule} /><span>{String(schedules.length).padStart(2, '0')}</span></p>
          <div className={styles.titleLine}><h1>{t('Automations')}<span>.</span></h1><p>{t('Set the trigger. Loam takes it from here.')}</p></div>
        </div>
        <div className={styles.createWrap}>
          <button type="button" onClick={() => { setCreateMenu((value) => !value); setFilterMenu(false); }} className={styles.primaryButton} aria-expanded={createMenu}><Plus />{t('Create')}<ArrowUpRight /></button>
          {createMenuContent}
        </div>
      </header>

      <div className={styles.scroll}>
        <section className={styles.hero} aria-label={t('Automation overview')}>
          <div className={styles.heroCopy}>
            <p className={styles.liveBadge}><Radio />{activeCount > 0 ? t('Running quietly in the background') : t('Ready when you are')}</p>
            <h2>{activeCount > 0 ? t('Your work is in motion.') : t('Put your repeat work on autopilot.')}</h2>
            <p>{t('Schedules, events, and intelligent playbooks — one calm place to keep them moving.')}</p>
          </div>
          <div className={styles.routeArt} aria-hidden="true">
            <span className={styles.routeLine} />
            <span className={styles.routeNode}><Clock /></span>
            <span className={styles.routeNode}><Zap /></span>
            <span className={styles.routeNode}><Check /></span>
          </div>
          <div className={styles.metrics}>
            <div className={styles.metric}><span>{t('Active')}</span><strong>{String(activeCount).padStart(2, '0')}</strong><Activity /></div>
            <div className={styles.metric}><span>{t('On pause')}</span><strong>{String(pausedCount).padStart(2, '0')}</strong><CirclePause /></div>
            <div className={styles.metric}><span>{t('Runs logged')}</span><strong>{String(updates.length).padStart(2, '0')}</strong><ArrowUpRight /></div>
          </div>
        </section>

        <section className={styles.console}>
          <header className={styles.consoleHeader}>
            <div className={styles.tabs} role="tablist" aria-label={t('Automation views')}>
              <button role="tab" aria-label={t('Updates')} aria-selected={tab === 'updates'} onClick={() => setTab('updates')} className={clsx(styles.tab, tab === 'updates' && styles.tabActive)}><Activity />{t('Updates')}<span>{updates.length}</span></button>
              <button role="tab" aria-label={t('Manage')} aria-selected={tab === 'manage'} onClick={() => setTab('manage')} className={clsx(styles.tab, tab === 'manage' && styles.tabActive)}><Workflow />{t('Manage')}<span>{schedules.length}</span></button>
            </div>
            <div className={styles.consoleTools}>
              {tab === 'updates' && <div className={styles.viewSwitch}><button type="button" aria-label={t('List view')} aria-pressed={updatesView === 'list'} onClick={() => setUpdatesView('list')} className={clsx(updatesView === 'list' && styles.viewActive)}><List /></button><button type="button" aria-label={t('Grid view')} aria-pressed={updatesView === 'grid'} onClick={() => setUpdatesView('grid')} className={clsx(updatesView === 'grid' && styles.viewActive)}><LayoutGrid /></button></div>}
              <div className={styles.filterWrap}>
                <button type="button" aria-label={t('Filter')} aria-expanded={filterMenu} onClick={() => { setFilterMenu((value) => !value); setCreateMenu(false); }} className={clsx(styles.filterButton, statusFilter !== 'all' && styles.filterActive)}><SlidersHorizontal />{statusFilter !== 'all' && <span />}</button>
                {filterMenu && <div role="menu" className={clsx(styles.menu, styles.filterMenu)}>{(['all', 'active', 'paused'] as const).map((filter) => <button key={filter} role="menuitemradio" aria-checked={statusFilter === filter} onClick={() => { setStatusFilter(filter); setFilterMenu(false); }} className={styles.menuItem}><span className={clsx(styles.filterDot, filter === 'active' && styles.filterDotActive, filter === 'paused' && styles.filterDotPaused)} />{t(filter === 'all' ? 'All automations' : filter === 'active' ? 'Active' : 'Paused')}{statusFilter === filter && <Check className={styles.menuArrow} />}</button>)}</div>}
              </div>
            </div>
          </header>

          <div className={styles.consoleBody} aria-live="polite">
            {error && schedules.length > 0 && <div className={styles.inlineError} role="alert"><AlertCircle /><span>{error}</span><button type="button" onClick={() => { setLoading(true); void refresh(); }}>{t('Retry')}</button></div>}
            {loading ? <div className={styles.state}><Loader2 className="size-6 animate-spin" /><p>{t('Loading')}</p></div> : error && schedules.length === 0 ? (
              <div className={styles.state} role="alert"><AlertCircle className="size-7 text-func-error" /><p>{t('Failed to load automations')}</p><small>{error}</small><button type="button" onClick={() => { setLoading(true); void refresh(); }} className={styles.secondaryButton}>{t('Retry')}</button></div>
            ) : tab === 'updates' ? (
              updates.length === 0 ? <div className={styles.emptyState}><div className={styles.emptyArt} aria-hidden="true"><span><Clock /></span><i /><span><Zap /></span><i /><span><Check /></span></div><p>{t('No automation updates yet.')}</p><small>{t('Your latest automation activity will collect here.')}</small><button type="button" onClick={() => setCreateMenu(true)} className={styles.secondaryButton}><Plus />{t('Create your first automation')}</button></div> : (
                <div className={styles.timeline}>
                  {updateGroups.map(([date, items]) => (
                    <section key={date} className={styles.dayGroup}>
                      <h2><span>{new Intl.DateTimeFormat(getLocale() === 'ar' ? 'ar' : 'en', { month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00`))}</span><span>{String(items.length).padStart(2, '0')}</span></h2>
                      <div className={clsx(styles.updateItems, updatesView === 'grid' && styles.updateGrid)}>
                        {items.map((s) => <button key={s.id} type="button" onClick={() => { if (s.lastTaskId) router.push(`/app/${s.lastTaskId}`); }} className={styles.updateRow}><span className={clsx(styles.updateStatus, s.lastStatus === 'failed' && styles.updateFailed)}>{s.lastStatus === 'failed' ? <AlertCircle /> : <CheckCircle2 />}</span><span className={styles.updateCopy}><strong>{s.prompt}</strong><span>{updateSummary(s)}</span></span><span className={styles.updateTime}><time>{formatDateTime(s.lastRunAt!)}</time><ArrowUpRight /></span></button>)}
                      </div>
                    </section>
                  ))}
                </div>
              )
            ) : (
              <div>
                {webhookSetup && <WebhookSetup id={webhookSetup.id} secret={webhookSetup.secret} url={webhookUrl} copied={copied} onCopy={copySetup} onClose={() => setWebhookSetup(null)} />}
                {managed.length === 0 ? <div className={styles.emptyState}><div className={styles.emptyArt} aria-hidden="true"><span><Clock /></span><i /><span><Zap /></span><i /><span><Check /></span></div><p>{schedules.length === 0 ? t('No automations yet.') : t('No automations match this filter.')}</p><small>{t('Put your repeat work on autopilot.')}</small><button type="button" onClick={() => setCreateMenu(true)} className={styles.secondaryButton}><Plus />{t('Create your first automation')}</button></div> : (
                  <div className={styles.manageList}>
                    <div className={styles.manageColumns} aria-hidden="true"><span>{t('Automation')}</span><span>{t('Trigger')}</span><span>{t('Last run')}</span><span>{t('Status')}</span></div>
                    {managed.map((s, index) => (
                      <article key={s.id} className={styles.manageRow}>
                        <div className={styles.automationIdentity}><span>{String(index + 1).padStart(2, '0')}</span><i>{s.trigger === 'webhook' || s.trigger === 'github' ? <Webhook /> : s.playbook ? <Workflow /> : <Clock />}</i></div>
                        <div className={styles.automationCopy}><h2 title={s.prompt}>{s.prompt}</h2><p>{s.playbook || s.prompt}</p></div>
                        <div className={styles.automationTiming}><span>{triggerLabel(s)}</span><strong dir="auto">{scheduleLabel(s)}</strong></div>
                        <div className={styles.automationLastRun}><span>{t('Last run')}</span><time>{s.lastRunAt ? formatDateTime(s.lastRunAt) : t('Never run')}</time></div>
                        <div className={styles.automationState}><span className={clsx(styles.statusPill, !s.enabled && styles.statusPaused)}><i />{t(s.enabled ? 'Active' : 'Paused')}</span><button type="button" aria-label={t('Automation actions')} aria-expanded={menuId === s.id} onClick={() => setMenuId(menuId === s.id ? null : s.id)} className={styles.moreButton}>{busyId === s.id ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}</button>
                          {menuId === s.id && <div className={clsx(styles.menu, styles.actionMenu)}><button type="button" onClick={() => { setMenuId(null); void runNow(s); }} disabled={busyId === s.id} className={styles.menuItem}><Play />{t('Run now')}</button><button type="button" onClick={() => { setMenuId(null); void toggle(s); }} disabled={busyId === s.id} className={styles.menuItem}><Zap />{t(s.enabled ? 'Pause' : 'Resume')}</button><button type="button" onClick={() => { setMenuId(null); setFormError(null); setDraft({ id: s.id, prompt: s.prompt, kind: s.trigger === 'webhook' || s.trigger === 'github' ? s.trigger : s.playbook ? 'advanced' : s.cron ? 'cron' : s.runAt ? 'once' : 'interval', intervalSeconds: String(s.intervalSeconds ?? 3600), cron: s.cron ?? '', at: s.runAt ?? '', webhookSecret: newSecret(), githubEvents: s.githubEvents?.join(', ') ?? 'pull_request.opened' }); }} className={styles.menuItem}><Pencil />{t('Edit')}</button>{confirmDelete === s.id ? <button type="button" onClick={() => void remove(s.id)} disabled={busyId === s.id} className={clsx(styles.menuItem, styles.deleteItem)}>{t('Confirm delete')}</button> : <button type="button" onClick={() => setConfirmDelete(s.id)} className={clsx(styles.menuItem, styles.deleteItem)}><Trash2 />{t('Delete')}</button>}</div>}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
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
