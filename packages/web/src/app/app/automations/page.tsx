'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Clock, Zap, Play, Pencil, Trash2, Plus, X, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Dialog } from '@/components/ui/Dialog';

interface Schedule {
  id: string;
  prompt: string;
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  cron?: string;
  runAt?: string;
  timezone?: string;
  agentId?: string;
  kind?: string;
}

type DraftKind = 'interval' | 'cron' | 'once';

interface Draft {
  id?: string;
  prompt: string;
  kind: DraftKind;
  intervalSeconds: string;
  cron: string;
  at: string;
}

function scheduleLabel(s: Schedule): string {
  if (s.cron) return s.cron;
  if (s.runAt) return `${t('Once at')} ${s.runAt}`;
  const seconds = s.intervalSeconds || 0;
  if (seconds % 3600 === 0 && seconds > 0) return `${t('Every')} ${seconds / 3600} ${t('h')}`;
  if (seconds % 60 === 0 && seconds > 0) return `${t('Every')} ${seconds / 60} ${t('min')}`;
  return `${t('Every')} ${seconds} ${t('s')}`;
}

export default function AutomationsPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/schedules`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { schedules?: Schedule[] };
      setSchedules(data.schedules ?? []);
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // eslint-disable-next-line no-console
      console.error('failed to load automations', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveDraft = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || !draft.prompt.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      const headers = { 'content-type': 'application/json', ...(await getApiHeaders()) };
      if (draft.id) {
        const res = await fetch(`${getApiBase()}/api/schedules/${encodeURIComponent(draft.id)}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ prompt: draft.prompt.trim() }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `status ${res.status}`);
        }
      } else {
        const body: Record<string, unknown> = { prompt: draft.prompt.trim() };
        if (draft.kind === 'interval') body.intervalSeconds = Number(draft.intervalSeconds) || 3600;
        if (draft.kind === 'cron') body.cron = draft.cron.trim();
        if (draft.kind === 'once') body.at = new Date(draft.at).toISOString();
        const res = await fetch(`${getApiBase()}/api/schedules`, { method: 'POST', headers, body: JSON.stringify(body) });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `status ${res.status}`);
      }
      setDraft(null);
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
      const res = await fetch(`${getApiBase()}/api/schedules/${encodeURIComponent(s.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
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
      const res = await fetch(`${getApiBase()}/api/schedules/${encodeURIComponent(s.id)}/run-now`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`${getApiBase()}/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE', headers: await getApiHeaders() });
      setConfirmDelete(null);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const openNew = () => {
    setFormError(null);
    setDraft({ prompt: '', kind: 'interval', intervalSeconds: '3600', cron: '', at: '' });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-title-lg text-text-primary">{t('Automations')}</h1>
        <button
          type="button"
          onClick={openNew}
          className="ms-auto flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"
        >
          <Plus className="size-4" /> {t('New automation')}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error && schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-func-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load automations')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
            <Zap className="size-8" />
            <p className="text-sm">{t('No automations yet.')}</p>
            <button
              type="button"
              onClick={openNew}
              className="flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"
            >
              <Plus className="size-4" /> {t('Create your first automation')}
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {error && <li className="text-xs text-func-error">{error}</li>}
            {schedules.map((s) => (
              <li key={s.id} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                {s.cron || s.runAt ? <Clock className="size-4 shrink-0 text-text-tertiary" /> : <Zap className="size-4 shrink-0 text-text-tertiary" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary" title={s.prompt}>{s.prompt}</p>
                  <p className="text-xs text-text-tertiary">
                    {scheduleLabel(s)}
                    {s.nextRunAt ? ` - ${t('Next')}: ${s.nextRunAt}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={s.enabled ? t('Disable') : t('Enable')}
                  disabled={busyId === s.id}
                  onClick={() => void toggle(s)}
                  className={clsx(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    s.enabled ? 'bg-fill-tsp text-func-success' : 'bg-fill-tsp text-text-tertiary',
                  )}
                >
                  {s.enabled ? t('Enabled') : t('Disabled')}
                </button>
                <button
                  type="button"
                  aria-label={t('Run now')}
                  title={t('Run now')}
                  disabled={busyId === s.id}
                  onClick={() => void runNow(s)}
                  className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
                >
                  <Play className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('Edit')}
                  onClick={() => {
                    setFormError(null);
                    setDraft({
                      id: s.id,
                      prompt: s.prompt,
                      kind: s.cron ? 'cron' : s.runAt ? 'once' : 'interval',
                      intervalSeconds: String(s.intervalSeconds ?? 3600),
                      cron: s.cron ?? '',
                      at: s.runAt ?? '',
                    });
                  }}
                  className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
                >
                  <Pencil className="size-3.5" />
                </button>
                {confirmDelete === s.id ? (
                  <button
                    type="button"
                    onClick={() => void remove(s.id)}
                    disabled={busyId === s.id}
                    className="shrink-0 rounded-control px-1.5 py-1 text-[11px] font-medium text-func-error hover:bg-fill-hover"
                  >
                    {t('Confirm delete')}
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={t('Delete')}
                    onClick={() => setConfirmDelete(s.id)}
                    className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-func-error"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={draft !== null} onClose={() => setDraft(null)} title={draft?.id ? t('Edit automation') : t('New automation')}>
        {draft && (
          <form onSubmit={saveDraft} className="flex flex-col gap-3">
            <textarea
              autoFocus
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder={t('What should {product} do?')}
              rows={3}
              className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            {!draft.id && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-1 rounded-card bg-fill-tsp p-1">
                  {(['interval', 'cron', 'once'] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setDraft({ ...draft, kind })}
                      className={clsx(
                        'flex-1 rounded-control px-2 py-1 text-xs font-medium',
                        draft.kind === kind ? 'bg-bg-menu text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
                      )}
                    >
                      {kind === 'interval' ? t('Recurring') : kind === 'cron' ? t('Cron') : t('One time')}
                    </button>
                  ))}
                </div>
                {draft.kind === 'interval' && (
                  <input
                    type="number"
                    min={30}
                    value={draft.intervalSeconds}
                    onChange={(e) => setDraft({ ...draft, intervalSeconds: e.target.value })}
                    placeholder={t('Interval in seconds (min 30)')}
                    className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
                  />
                )}
                {draft.kind === 'cron' && (
                  <input
                    type="text"
                    value={draft.cron}
                    onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                    placeholder="0 9 * * *"
                    className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
                  />
                )}
                {draft.kind === 'once' && (
                  <input
                    type="datetime-local"
                    value={draft.at}
                    onChange={(e) => setDraft({ ...draft, at: e.target.value })}
                    className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary"
                  />
                )}
              </div>
            )}
            {draft.id && (
              <p className="text-xs text-text-tertiary">{t('The schedule stays unchanged when editing.')}</p>
            )}
            {formError && <p className="text-xs text-func-error">{formError}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="flex items-center gap-1 rounded-control px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover"
              >
                <X className="size-4" /> {t('Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !draft.prompt.trim()}
                className="flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50"
              >
                {saving && <Loader2 className="size-4 animate-spin" />} {t('Save')}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
