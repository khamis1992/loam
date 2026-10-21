'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, Plus, Search, Wrench, Trash2, Eye, Pencil, X } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  createMemorySkill,
  deleteMemorySkill,
  getMemorySkill,
  listMemorySkills,
  updateMemorySkill,
  type MemorySkillSummary,
} from '@/services/memorySkillsApi';

/**
 * Settings › Skills (UNIMPLEMENTED_OPTIONS #4).
 *
 * Surfaces the persistent skills recorded by the agent through the
 * memory-skills MCP backend (via the `/api/memory-skills` route): list, create,
 * view, edit and delete `skills/<slug>/SKILL.md` entries.
 */

type DialogMode = 'create' | 'edit' | 'view';

interface DialogState {
  open: boolean;
  mode: DialogMode;
  slug: string;
  name: string;
  description: string;
  body: string;
  busy: boolean;
  error: string | null;
}

const closedDialog: DialogState = { open: false, mode: 'create', slug: '', name: '', description: '', body: '', busy: false, error: null };

export function SkillsPane() {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const [skills, setSkills] = useState<MemorySkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const markBusy = (key: string, on: boolean) => setBusy((prev) => ({ ...prev, [key]: on }));

  const [dlg, setDlg] = useState<DialogState>(closedDialog);
  const [confirmDelete, setConfirmDelete] = useState<MemorySkillSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listMemorySkills();
      setSkills(data.skills ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? skills.filter((s) => `${s.name} ${s.slug} ${s.description}`.toLowerCase().includes(q)) : skills;
  }, [skills, filter]);

  const openCreate = () => setDlg({ ...closedDialog, open: true, mode: 'create' });

  const openView = async (slug: string) => {
    setDlg({ ...closedDialog, open: true, mode: 'view', slug });
    markBusy(`view:${slug}`, true);
    try {
      const detail = await getMemorySkill(slug);
      setDlg((prev) => (prev.open ? { ...prev, mode: 'view', slug: detail.slug, name: detail.name, description: detail.description, body: detail.body } : prev));
    } catch (e) {
      setDlg((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      markBusy(`view:${slug}`, false);
    }
  };

  const startEdit = () => setDlg((prev) => ({ ...prev, mode: 'edit', error: null }));

  const openEdit = async (summary: MemorySkillSummary) => {
    setDlg({ ...closedDialog, open: true, mode: 'edit', slug: summary.slug, name: summary.name, description: summary.description });
    markBusy(`edit:${summary.slug}`, true);
    try {
      const detail = await getMemorySkill(summary.slug);
      setDlg((prev) => (prev.open ? { ...prev, mode: 'edit', slug: detail.slug, name: detail.name, description: detail.description, body: detail.body } : prev));
    } catch (e) {
      setDlg((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      markBusy(`edit:${summary.slug}`, false);
    }
  };

  const save = async () => {
    const name = dlg.name.trim();
    const description = dlg.description.trim();
    const body = dlg.body;
    if (!name) { setDlg((prev) => ({ ...prev, error: t('Name is required') })); return; }
    if (!description) { setDlg((prev) => ({ ...prev, error: t('Description is required') })); return; }
    if (!body.trim()) { setDlg((prev) => ({ ...prev, error: t('Instructions are required') })); return; }
    setDlg((prev) => ({ ...prev, busy: true, error: null }));
    try {
      const input = { name, description, body };
      if (dlg.mode === 'edit') await updateMemorySkill(dlg.slug, input);
      else await createMemorySkill(input);
      notify(dlg.mode === 'edit' ? t('Skill saved') : t('Skill created'), 'ok');
      setDlg(closedDialog);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDlg((prev) => ({ ...prev, busy: false, error: msg }));
      notify(msg, 'err');
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    const slug = confirmDelete.slug;
    setDeleting(true);
    try {
      await deleteMemorySkill(slug);
      notify(t('Skill removed'), 'ok');
      if (dlg.open && dlg.slug === slug) setDlg(closedDialog);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-2">
      <Section title={t('Installed skills')}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus className="size-4" /> {t('Create skill')}
          </Button>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-text-tertiary start-2.5" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('Filter installed skills')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp ps-8 pe-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </div>
          <span className="shrink-0 rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
            {skills.length} {t('Installed')}
          </span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 py-4 text-function-error">
            <AlertCircle className="size-4 shrink-0" />
            <p className="text-sm">{t('Failed to load skills')} {error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-sm text-text-tertiary">{skills.length === 0 ? t('No installed skills.') : t('No results.')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((s) => (
              <li key={s.slug} className="flex items-start gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                <Wrench className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{s.name}</p>
                  <p className="font-mono text-[11px] text-text-tertiary">skills/{s.slug} · v{s.version}</p>
                  {s.description && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{s.description}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" size="sm" disabled={busy[`view:${s.slug}`]} onClick={() => void openView(s.slug)}>
                    {busy[`view:${s.slug}`] ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} {t('View')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy[`edit:${s.slug}`]} onClick={() => void openEdit(s)}>
                    {busy[`edit:${s.slug}`] ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />} {t('Edit')}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setConfirmDelete(s)}>
                    <Trash2 className="size-4" /> {t('Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Dialog open={dlg.open} onClose={() => setDlg(closedDialog)} title={dialogTitle(dlg.mode)} width={560}>
        <div className="flex flex-col gap-3">
          <Field label={t('Skill name')}>
            <input
              type="text"
              value={dlg.name}
              disabled={dlg.mode !== 'create'}
              onChange={(e) => setDlg((p) => ({ ...p, name: e.target.value }))}
              placeholder="release-check"
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
            />
          </Field>
          <Field label={t('Description')}>
            <input
              type="text"
              value={dlg.description}
              disabled={dlg.mode === 'view'}
              onChange={(e) => setDlg((p) => ({ ...p, description: e.target.value }))}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
            />
          </Field>
          <Field label={t('Instructions')}>
            <textarea
              value={dlg.body}
              readOnly={dlg.mode === 'view'}
              onChange={(e) => setDlg((p) => ({ ...p, body: e.target.value }))}
              className="min-h-[220px] w-full rounded-control border border-border-main bg-fill-tsp p-3 font-mono text-xs text-text-primary placeholder:text-text-tertiary"
            />
          </Field>

          {dlg.error && (
            <p className="flex items-center gap-1.5 text-sm text-function-error">
              <AlertCircle className="size-4" /> {dlg.error}
            </p>
          )}

          <div className="mt-1 flex items-center justify-end gap-2">
            {dlg.mode === 'view' ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setDlg(closedDialog)}><X className="size-4" /> {t('Close')}</Button>
                <Button variant="primary" size="sm" onClick={startEdit}><Pencil className="size-4" /> {t('Edit')}</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => setDlg(closedDialog)} disabled={dlg.busy}>{t('Cancel')}</Button>
                <Button variant="primary" size="sm" onClick={() => void save()} loading={dlg.busy}>
                  {dlg.mode === 'edit' ? t('Save') : t('Create')}
                </Button>
              </>
            )}
          </div>
        </div>
      </Dialog>

      <Dialog open={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title={t('Delete skill?')} width={420}>
        <p className="mb-4 text-sm text-text-secondary">
          {t('This permanently removes the skill. This cannot be undone.')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>{t('Cancel')}</Button>
          <Button variant="danger" size="sm" loading={deleting} onClick={() => void remove()}>{t('Delete')}</Button>
        </div>
      </Dialog>

      {toast && (
        <div className="fixed bottom-5 start-5 z-[70]">
          <div className={clsx('max-w-[420px] rounded-card px-3.5 py-2.5 text-sm shadow-layer', toast.kind === 'ok' ? 'bg-function-success text-white' : 'bg-func-error text-white')}>
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}

function dialogTitle(mode: DialogMode): string {
  if (mode === 'create') return t('Create skill');
  if (mode === 'edit') return t('Edit');
  return t('Skill details');
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}
