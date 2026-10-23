'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, Plus, Search, BookMarked, Trash2, Eye, Pencil, X, History, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  PLAYBOOK_SECTION_KEYS,
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  listPlaybookVersions,
  listPlaybooks,
  restorePlaybookVersion,
  updatePlaybook,
  type Playbook,
  type PlaybookSectionKey,
  type PlaybookSections,
  type PlaybookVersion,
} from '@/services/playbooksApi';

/**
 * Settings › Playbooks (D9).
 *
 * The versioned, reusable prompt library: each playbook is a macro (`!name`) plus
 * six authored sections. This pane lists, creates, edits, views and deletes them,
 * and shows the immutable version history so an earlier revision can be restored.
 */

const SECTION_LABELS: Record<PlaybookSectionKey, string> = {
  overview: 'Overview',
  procedure: 'Procedure',
  specifications: 'Specifications',
  advice: 'Advice',
  forbiddenActions: 'Forbidden actions',
  neededFromUser: 'Needed from user',
};

/** `!My_Macro` / `My_Macro` / `!!my_macro` all normalize to `my_macro`. */
function normalizeMacro(value: string): string {
  return value.trim().replace(/^!+/, '').trim().toLowerCase();
}

const MACRO_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function emptySections(): PlaybookSections {
  return {
    overview: '',
    procedure: '',
    specifications: '',
    advice: '',
    forbiddenActions: '',
    neededFromUser: '',
  };
}

type DialogMode = 'create' | 'edit' | 'view';

interface DialogState {
  open: boolean;
  mode: DialogMode;
  id: string;
  name: string;
  macro: string;
  sections: PlaybookSections;
  busy: boolean;
  error: string | null;
}

const closedDialog: DialogState = {
  open: false,
  mode: 'create',
  id: '',
  name: '',
  macro: '',
  sections: emptySections(),
  busy: false,
  error: null,
};

export function PlaybooksPane() {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const markBusy = (key: string, on: boolean) => setBusy((prev) => ({ ...prev, [key]: on }));

  const [dlg, setDlg] = useState<DialogState>(closedDialog);
  const [confirmDelete, setConfirmDelete] = useState<Playbook | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [versions, setVersions] = useState<PlaybookVersion[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listPlaybooks();
      setPlaybooks(data.playbooks ?? []);
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
    return q ? playbooks.filter((p) => `${p.name} ${p.macro} ${p.overview}`.toLowerCase().includes(q)) : playbooks;
  }, [playbooks, filter]);

  const openCreate = () => setDlg({ ...closedDialog, open: true, mode: 'create', sections: emptySections() });

  const openView = async (playbook: Playbook) => {
    setDlg({ ...closedDialog, open: true, mode: 'view', id: playbook.id, name: playbook.name, macro: playbook.macro, sections: emptySections() });
    markBusy(`view:${playbook.id}`, true);
    try {
      const { playbook: detail } = await getPlaybook(playbook.id);
      setDlg((prev) => (prev.open ? { ...prev, mode: 'view', id: detail.id, name: detail.name, macro: detail.macro, sections: pickSections(detail) } : prev));
    } catch (e) {
      setDlg((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      markBusy(`view:${playbook.id}`, false);
    }
  };

  const openEdit = async (playbook: Playbook) => {
    setDlg({ ...closedDialog, open: true, mode: 'edit', id: playbook.id, name: playbook.name, macro: playbook.macro, sections: emptySections() });
    markBusy(`edit:${playbook.id}`, true);
    try {
      const { playbook: detail } = await getPlaybook(playbook.id);
      setDlg((prev) => (prev.open ? { ...prev, mode: 'edit', id: detail.id, name: detail.name, macro: detail.macro, sections: pickSections(detail) } : prev));
    } catch (e) {
      setDlg((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      markBusy(`edit:${playbook.id}`, false);
    }
  };

  const save = async () => {
    const name = dlg.name.trim();
    const macro = normalizeMacro(dlg.macro);
    if (!name) { setDlg((prev) => ({ ...prev, error: t('Name is required') })); return; }
    if (!macro) { setDlg((prev) => ({ ...prev, error: t('Macro is required') })); return; }
    if (!MACRO_PATTERN.test(macro)) {
      setDlg((prev) => ({ ...prev, error: t('Macro must be lowercase letters, digits or underscores and start with a letter') }));
      return;
    }
    setDlg((prev) => ({ ...prev, busy: true, error: null }));
    try {
      if (dlg.mode === 'edit') {
        await updatePlaybook(dlg.id, { name, macro, ...dlg.sections });
        notify(t('Playbook saved'), 'ok');
      } else {
        await createPlaybook({ name, macro, ...dlg.sections });
        notify(t('Playbook created'), 'ok');
      }
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
    const id = confirmDelete.id;
    setDeleting(true);
    try {
      await deletePlaybook(id);
      notify(t('Playbook removed'), 'ok');
      if (dlg.open && dlg.id === id) setDlg(closedDialog);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setDeleting(false);
    }
  };

  const openHistory = async (playbook: Playbook) => {
    setHistoryId(playbook.id);
    setVersions([]);
    setHistoryError(null);
    setHistoryBusy(true);
    try {
      const data = await listPlaybookVersions(playbook);
      setVersions(data.versions ?? []);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e));
    } finally {
      setHistoryBusy(false);
    }
  };

  const restore = async (version: PlaybookVersion) => {
    const playbook = playbooks.find((p) => p.id === version.playbookId);
    if (!playbook) return;
    setRestoring(version.version);
    try {
      await restorePlaybookVersion(playbook, version.version);
      notify(t('Playbook restored'), 'ok');
      setHistoryId(null);
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="space-y-2">
      <Section title={t('Playbooks')}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus className="size-4" /> {t('Create playbook')}
          </Button>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-text-tertiary start-2.5" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('Filter playbooks')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp ps-8 pe-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </div>
          <span className="shrink-0 rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
            {playbooks.length} {t('Playbooks')}
          </span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 py-4 text-function-error">
            <AlertCircle className="size-4 shrink-0" />
            <p className="text-sm">{t('Failed to load playbooks')} {error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-sm text-text-tertiary">
            {playbooks.length === 0
              ? t('No playbooks yet. Create one, or draft it from a finished session with playbook_create_from_session.')
              : t('No results.')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((p) => (
              <li key={p.id} className="flex items-start gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                <BookMarked className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{p.name}</p>
                  <p className="font-mono text-[11px] text-text-tertiary">!{p.macro} · v{p.currentVersion}</p>
                  {p.overview && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{p.overview}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" size="sm" disabled={busy[`view:${p.id}`]} onClick={() => void openView(p)}>
                    {busy[`view:${p.id}`] ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} {t('View')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy[`edit:${p.id}`]} onClick={() => void openEdit(p)}>
                    {busy[`edit:${p.id}`] ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />} {t('Edit')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void openHistory(p)}>
                    <History className="size-4" /> {t('History')}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setConfirmDelete(p)}>
                    <Trash2 className="size-4" /> {t('Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Dialog open={dlg.open} onClose={() => setDlg(closedDialog)} title={dialogTitle(dlg.mode)} width={640}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Playbook name')}>
              <input
                type="text"
                value={dlg.name}
                disabled={dlg.mode === 'view'}
                onChange={(e) => setDlg((p) => ({ ...p, name: e.target.value }))}
                placeholder="Release checklist"
                className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
              />
            </Field>
            <Field label={t('Macro')}>
              <input
                type="text"
                value={dlg.macro}
                disabled={dlg.mode !== 'create'}
                onChange={(e) => setDlg((p) => ({ ...p, macro: e.target.value }))}
                placeholder="!release_checklist"
                className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 font-mono text-sm text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
              />
            </Field>
          </div>

          {PLAYBOOK_SECTION_KEYS.map((key) => (
            <Field key={key} label={t(SECTION_LABELS[key])}>
              <textarea
                value={dlg.sections[key]}
                readOnly={dlg.mode === 'view'}
                onChange={(e) => setDlg((p) => ({ ...p, sections: { ...p.sections, [key]: e.target.value } }))}
                rows={key === 'overview' ? 2 : 4}
                placeholder={t(SECTION_LABELS[key])}
                className="min-h-[64px] w-full rounded-control border border-border-main bg-fill-tsp p-3 font-mono text-xs text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
              />
            </Field>
          ))}

          {dlg.error && (
            <p className="flex items-center gap-1.5 text-sm text-function-error">
              <AlertCircle className="size-4" /> {dlg.error}
            </p>
          )}

          <div className="mt-1 flex items-center justify-end gap-2">
            {dlg.mode === 'view' ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setDlg(closedDialog)}><X className="size-4" /> {t('Close')}</Button>
                <Button variant="primary" size="sm" onClick={() => setDlg((p) => ({ ...p, mode: 'edit', error: null }))}><Pencil className="size-4" /> {t('Edit')}</Button>
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

      <Dialog open={historyId !== null} onClose={() => setHistoryId(null)} title={t('Version history')} width={560}>
        <div className="flex flex-col gap-3">
          {historyBusy ? (
            <div className="flex items-center gap-2 py-4 text-text-secondary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          ) : historyError ? (
            <p className="flex items-center gap-1.5 text-sm text-function-error">
              <AlertCircle className="size-4" /> {historyError}
            </p>
          ) : versions.length === 0 ? (
            <p className="py-4 text-sm text-text-tertiary">{t('No versions.')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">v{v.version}</p>
                    <p className="text-[11px] text-text-tertiary">
                      {new Date(v.createdAt).toLocaleString()}
                      {v.createdBy ? ` · ${v.createdBy}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={restoring === v.version}
                    onClick={() => void restore(v)}
                  >
                    <RotateCcw className="size-4" /> {t('Restore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>

      <Dialog open={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title={t('Delete playbook?')} width={420}>
        <p className="mb-4 text-sm text-text-secondary">
          {t('This permanently removes the playbook and its version history. This cannot be undone.')}
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

function pickSections(playbook: Playbook): PlaybookSections {
  const sections = emptySections();
  for (const key of PLAYBOOK_SECTION_KEYS) sections[key] = playbook[key] ?? '';
  return sections;
}

function dialogTitle(mode: DialogMode): string {
  if (mode === 'create') return t('Create playbook');
  if (mode === 'edit') return t('Edit playbook');
  return t('Playbook details');
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}
