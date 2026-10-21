'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, Plus, Search, RefreshCw, Wrench, Check, Trash2, Eye, Pencil, Package, X } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

interface Skill {
  name: string;
  description?: string;
}

interface CatalogHit {
  id: string;
  files: number;
  description?: string;
}

interface CatalogResponse {
  source?: string;
  total?: number;
  shown?: number;
  skills?: CatalogHit[];
  error?: string;
}

interface SkillView {
  name: string;
  description?: string;
  body?: string;
  file?: string;
  content?: string;
  error?: string;
}

type Tab = 'installed' | 'catalog';
type DialogMode = 'create' | 'edit' | 'view';

interface DialogState {
  open: boolean;
  mode: DialogMode;
  name: string;
  description: string;
  body: string;
  busy: boolean;
  error: string | null;
}

const closedDialog: DialogState = { open: false, mode: 'create', name: '', description: '', body: '', busy: false, error: null };

async function getJson(path: string): Promise<unknown> {
  const headers = await getApiHeaders();
  const res = await fetch(`${getApiBase()}${path}`, { headers });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `status ${res.status}`));
  return data;
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const headers = { ...(await getApiHeaders()), 'content-type': 'application/json' };
  const res = await fetch(`${getApiBase()}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

const okMessage = (data: Record<string, unknown>): string | null =>
  data.ok === true ? null : String(data.message ?? data.error ?? 'failed');

function derivedName(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] || id;
}

function categoryOf(id: string): string {
  return id.split('/')[0] || '';
}

export function SkillsPane() {
  const [tab, setTab] = useState<Tab>('installed');
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // ---- installed ----
  const [installed, setInstalled] = useState<Skill[]>([]);
  const [installedLoading, setInstalledLoading] = useState(true);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // ---- catalog ----
  const [catalog, setCatalog] = useState<CatalogHit[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogSource, setCatalogSource] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([]);
  const [activeCat, setActiveCat] = useState('');
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // ---- per-item busy ----
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const markBusy = (key: string, on: boolean) => setBusy((prev) => ({ ...prev, [key]: on }));

  // ---- dialog ----
  const [dlg, setDlg] = useState<DialogState>(closedDialog);

  const installedNames = useMemo(() => new Set(installed.map((s) => s.name.toLowerCase())), [installed]);

  const loadInstalled = useCallback(async () => {
    try {
      const data = (await getJson('/api/skills')) as { skills?: Skill[] };
      setInstalled(data.skills ?? []);
      setInstalledError(null);
    } catch (e) {
      setInstalledError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalledLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async (query: string, refresh = false) => {
    setCatalogLoading(true);
    try {
      const params = new URLSearchParams({ q: query, limit: '60', describe: '10' });
      if (refresh) params.set('refresh', '1');
      const data = (await getJson(`/api/skills/catalog?${params.toString()}`)) as CatalogResponse;
      if (data.error) {
        setCatalogError(data.error);
        setCatalog([]);
        return;
      }
      setCatalog(data.skills ?? []);
      setCatalogTotal(data.total ?? 0);
      setCatalogSource(data.source ?? '');
      setCatalogError(null);
      setCatalogLoaded(true);
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : String(e));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const data = (await getJson('/api/skills/catalog?limit=200&describe=0')) as CatalogResponse;
      const counts = new Map<string, number>();
      for (const s of data.skills ?? []) {
        const c = categoryOf(s.id);
        if (c) counts.set(c, (counts.get(c) || 0) + 1);
      }
      setCategories([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, count]) => ({ name, count })));
      if (typeof data.total === 'number') setCatalogTotal(data.total);
    } catch {
      /* chips stay empty */
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await loadInstalled();
      if (mounted) void loadCategories();
    })();
    return () => { mounted = false; };
  }, [loadInstalled, loadCategories]);

  useEffect(() => {
    if (tab === 'catalog' && !catalogLoaded && !catalogLoading) void loadCatalog(catalogQuery);
  }, [tab, catalogLoaded, catalogLoading, catalogQuery, loadCatalog]);

  // debounce catalog search
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);
  const onCatalogInput = (value: string) => {
    setCatalogQuery(value);
    setActiveCat('');
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void loadCatalog(value.trim()), 350);
  };

  // ---- actions ----
  const selectCat = (c: string) => {
    setActiveCat(c);
    setCatalogQuery(c);
    void loadCatalog(c);
  };

  const refreshIndex = () => void loadCatalog(catalogQuery.trim(), true);

  const install = async (id: string, force: boolean) => {
    markBusy(id, true);
    const data = await postJson('/api/skills/install', { id, force });
    markBusy(id, false);
    if (data.error) { notify(String(data.error), 'err'); return; }
    notify(force ? t('Skill updated') : t('Skill installed'), 'ok');
    await loadInstalled();
  };

  const uninstall = async (name: string) => {
    markBusy(`del:${name}`, true);
    const data = await postJson('/api/skills/delete', { name });
    markBusy(`del:${name}`, false);
    const err = okMessage(data);
    if (err) { notify(err, 'err'); return; }
    notify(t('Skill removed'), 'ok');
    if (dlg.open && dlg.name === name) setDlg(closedDialog);
    await loadInstalled();
  };

  const openCreate = () => setDlg({ ...closedDialog, open: true, mode: 'create' });

  const openView = async (name: string) => {
    setDlg({ ...closedDialog, open: true, mode: 'view', name });
    try {
      const d = (await getJson(`/api/skills/one?name=${encodeURIComponent(name)}`)) as SkillView;
      setDlg((prev) => (prev.open ? { ...prev, mode: 'view', name: d.name ?? name, description: d.description ?? '', body: d.body ?? '' } : prev));
    } catch (e) {
      setDlg((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const startEdit = () => setDlg((prev) => ({ ...prev, mode: 'edit', error: null }));

  const saveSkill = async () => {
    const name = dlg.name.trim();
    const description = dlg.description.trim();
    const body = dlg.body;
    if (!name) { setDlg((prev) => ({ ...prev, error: t('Name is required') })); return; }
    if (!description) { setDlg((prev) => ({ ...prev, error: t('Description is required') })); return; }
    if (!body.trim()) { setDlg((prev) => ({ ...prev, error: t('Instructions are required') })); return; }
    setDlg((prev) => ({ ...prev, busy: true, error: null }));
    const data = dlg.mode === 'edit'
      ? await postJson('/api/skills/update', { name: dlg.name, description, body })
      : await postJson('/api/skills/create', { name, description, content: body });
    const err = okMessage(data);
    if (err) { setDlg((prev) => ({ ...prev, busy: false, error: err })); notify(err, 'err'); return; }
    notify(dlg.mode === 'edit' ? t('Skill saved') : t('Skill created'), 'ok');
    setDlg(closedDialog);
    await loadInstalled();
  };

  // ---- derived installed view ----
  const filteredInstalled = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? installed.filter((s) => `${s.name} ${s.description ?? ''}`.toLowerCase().includes(q)) : installed;
  }, [installed, filter]);

  return (
    <div className="space-y-2">
      {/* tabs */}
      <div className="mb-4 inline-flex rounded-control border border-border-main bg-fill-tsp p-0.5">
        {(['installed', 'catalog'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={clsx(
              'flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-sm font-medium transition-colors',
              tab === id ? 'bg-bg-menu text-text-primary shadow-card' : 'text-text-tertiary hover:text-text-secondary',
            )}
          >
            {id === 'installed' ? <Wrench className="size-3.5" /> : <Package className="size-3.5" />}
            {t(id === 'installed' ? 'Installed skills' : 'Skill catalog')}
          </button>
        ))}
      </div>

      {tab === 'installed' ? (
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
              {installed.length} {t('Installed')}
            </span>
          </div>

          {installedLoading ? (
            <div className="flex items-center gap-2 py-4 text-text-secondary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          ) : installedError ? (
            <div className="flex items-start gap-2 py-4 text-function-error">
              <AlertCircle className="size-4 shrink-0" />
              <p className="text-sm">{t('Failed to load skills')} {installedError}</p>
            </div>
          ) : filteredInstalled.length === 0 ? (
            <p className="py-4 text-sm text-text-tertiary">{installed.length === 0 ? t('No installed skills.') : t('No results.')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filteredInstalled.map((s) => (
                <li key={s.name} className="flex items-start gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                  <Wrench className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">{s.name}</p>
                    <p className="font-mono text-[11px] text-text-tertiary">skills/{s.name}</p>
                    {s.description && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{s.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => void openView(s.name)}>
                      <Eye className="size-4" /> {t('View')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy[`del:${s.name}`]}
                      onClick={() => void uninstall(s.name)}
                    >
                      {busy[`del:${s.name}`] ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      {t('Uninstall')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : (
        <Section title={t('Skill catalog')}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-text-tertiary start-2.5" />
              <input
                type="text"
                value={catalogQuery}
                onChange={(e) => onCatalogInput(e.target.value)}
                placeholder={t('Search the catalog')}
                className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp ps-8 pe-3 text-sm text-text-primary placeholder:text-text-tertiary"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={refreshIndex} disabled={catalogLoading}>
              <RefreshCw className={clsx('size-4', catalogLoading && 'animate-spin')} /> {t('Refresh index')}
            </Button>
          </div>

          {categories.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              <CatChip label={t('All tasks')} active={activeCat === ''} onClick={() => selectCat('')} />
              {categories.map((c) => (
                <CatChip key={c.name} label={c.name} count={c.count} active={activeCat === c.name} onClick={() => selectCat(c.name)} />
              ))}
            </div>
          )}

          {catalogError ? (
            <div className="flex items-start gap-2 py-4 text-function-error">
              <AlertCircle className="size-4 shrink-0" />
              <p className="text-sm">{t('Failed to load catalog')} {catalogError}</p>
            </div>
          ) : catalogLoading && catalog.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-text-secondary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          ) : catalog.length === 0 ? (
            <p className="py-4 text-sm text-text-tertiary">{t('No results.')}</p>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {catalog.map((s) => {
                  const installedHere = installedNames.has(derivedName(s.id).toLowerCase());
                  return (
                    <li key={s.id} className="flex items-start gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                      <Package className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-text-primary">{derivedName(s.id)}</p>
                          <span className="shrink-0 rounded-full bg-fill-tsp px-1.5 py-0.5 text-[10px] text-text-tertiary">{s.files} {t('Files')}</span>
                        </div>
                        <p className="font-mono text-[11px] text-text-tertiary" dir="ltr">{s.id}</p>
                        {s.description && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{s.description}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {installedHere ? (
                          <>
                            <span className="flex items-center gap-1 rounded-full bg-function-success-tsp px-2 py-0.5 text-[10px] font-medium text-function-success">
                              <Check className="size-3" /> {t('Installed')}
                            </span>
                            <Button variant="secondary" size="sm" disabled={busy[s.id]} onClick={() => void install(s.id, true)}>
                              {busy[s.id] ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                              {t('Update available')}
                            </Button>
                          </>
                        ) : (
                          <Button variant="primary" size="sm" disabled={busy[s.id]} onClick={() => void install(s.id, false)}>
                            {busy[s.id] ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                            {t('Install')}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {catalogSource && (
                <p className="mt-3 text-xs text-text-tertiary">{t('Skills loaded from the {name} catalog.', { name: catalogSource })} · {catalogTotal}</p>
              )}
            </>
          )}
        </Section>
      )}

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
                <Button variant="primary" size="sm" onClick={() => void saveSkill()} loading={dlg.busy}>
                  {dlg.mode === 'edit' ? t('Save') : t('Create')}
                </Button>
              </>
            )}
          </div>
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

function CatChip({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active ? 'border-transparent bg-text-primary text-text-onblack' : 'border-border-main text-text-secondary hover:text-text-primary',
      )}
    >
      {label}
      {typeof count === 'number' && <span className="opacity-60">{count}</span>}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}
