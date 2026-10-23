'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, BookMarked, Check, ChevronDown, ChevronRight, Loader2, Plus,
  Search, Sparkles, Tag, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  addKnowledgeSeed,
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteKnowledgeSeed,
  getKnowledgeBase,
  ingestKnowledge,
  listKnowledgeBases,
  retagKnowledgeSeed,
  searchKnowledge,
  type KnowledgeBaseSummary,
  type KnowledgeImportInput,
  type KnowledgeSearchHit,
  type KnowledgeSeedSummary,
} from '@/services/knowledgeApi';

/**
 * Settings › Knowledge Garden (Neo N3).
 *
 * The garden is a user-built RAG store: named bases of retrievable "seeds".
 * Everything on this page reads and writes the same store the agent's `kb_*`
 * tools use, so the settings page is a truthful view of what the model can
 * retrieve during a run.
 *
 * Two honest signals are surfaced rather than hidden:
 *  - `enabled` (false when the memory embedder is off) => search falls back to
 *    lexical-only and seeds are stored un-vectored. The pane says so.
 *  - import warnings (unsupported type, OCR skipped, splitter fallback) =>
 *    surfaced verbatim, because "nothing imported" must never look like success.
 */

type ImportSource = 'text' | 'file' | 'url';

export function KnowledgeGardenPane() {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const [bases, setBases] = useState<KnowledgeBaseSummary[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [baseFilter, setBaseFilter] = useState('');
  const [seedFilter, setSeedFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [seeds, setSeeds] = useState<Record<string, KnowledgeSeedSummary[]>>({});
  /** Which base each rendered seed belongs to (retagging needs it). */
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [seedsLoading, setSeedsLoading] = useState<string | null>(null);
  const [seedsError, setSeedsError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importBaseId, setImportBaseId] = useState('');
  const [importSource, setImportSource] = useState<ImportSource>('text');
  const [importText, setImportText] = useState('');
  const [importPath, setImportPath] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importTags, setImportTags] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);

  const [seedDraftBase, setSeedDraftBase] = useState('');
  const [seedTitle, setSeedTitle] = useState('');
  const [seedBody, setSeedBody] = useState('');
  const [seedTags, setSeedTags] = useState('');
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);

  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const [tagBusy, setTagBusy] = useState<Record<string, boolean>>({});

  const [confirmBase, setConfirmBase] = useState<KnowledgeBaseSummary | null>(null);
  const [confirmSeed, setConfirmSeed] = useState<{ baseId: string; seed: KnowledgeSeedSummary } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [query, setQuery] = useState('');
  const [searchBaseId, setSearchBaseId] = useState('');
  const [results, setResults] = useState<KnowledgeSearchHit[]>([]);
  const [searchMode, setSearchMode] = useState<'lexical' | 'hybrid'>('lexical');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listKnowledgeBases();
      setBases(data.bases ?? []);
      setEnabled(data.enabled !== false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadSeeds = useCallback(async (baseId: string) => {
    setSeedsLoading(baseId);
    setSeedsError(null);
    try {
      const data = await getKnowledgeBase(baseId);
      setSeeds((prev) => ({ ...prev, [baseId]: data.seeds ?? [] }));
      setOwners((prev) => {
        const next = { ...prev };
        for (const seed of data.seeds ?? []) next[seed.id] = baseId;
        return next;
      });
    } catch (e) {
      setSeedsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeedsLoading(null);
    }
  }, []);

  const toggle = (baseId: string) => {
    setExpanded((prev) => {
      const next = prev === baseId ? null : baseId;
      if (next && !seeds[next]) void loadSeeds(next);
      return next;
    });
  };

  const filteredBases = useMemo(() => {
    const q = baseFilter.trim().toLowerCase();
    return q ? bases.filter((b) => `${b.name} ${b.description ?? ''}`.toLowerCase().includes(q)) : bases;
  }, [bases, baseFilter]);

  const baseName = useCallback(
    (id: string) => bases.find((b) => b.id === id)?.name ?? id,
    [bases],
  );

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name) { setCreateError(t('Name is required')); return; }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const { base } = await createKnowledgeBase(name, createDescription.trim() || undefined);
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
      notify(t('Base created'));
      await load();
      setExpanded(base.id);
      await loadSeeds(base.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCreateError(msg);
      notify(msg, 'err');
    } finally {
      setCreateBusy(false);
    }
  };

  const openImport = (baseId: string) => {
    setImportBaseId(baseId);
    setImportOpen(true);
    setImportSource('text');
    setImportText('');
    setImportPath('');
    setImportUrl('');
    setImportTags('');
    setImportError(null);
    setImportWarnings([]);
  };

  const submitImport = async () => {
    const tags = splitTags(importTags);
    const payload: KnowledgeImportInput = { tags };
    if (importSource === 'text') payload.text = importText;
    else if (importSource === 'file') payload.path = importPath;
    else payload.url = importUrl;

    const missing = importSource === 'text' ? !importText.trim()
      : importSource === 'file' ? !importPath.trim()
      : !importUrl.trim();
    if (missing) { setImportError(t('Provide the source to import')); return; }

    setImportBusy(true);
    setImportError(null);
    setImportWarnings([]);
    try {
      const res = await ingestKnowledge(importBaseId, payload);
      setImportWarnings(res.warnings ?? []);
      if (!res.ok) {
        setImportError(t('Nothing could be imported from that source'));
        return;
      }
      notify(t(`Imported ${res.seeds.length} seed${res.seeds.length === 1 ? '' : 's'}`));
      setImportOpen(false);
      await load();
      await loadSeeds(importBaseId);
      if (!expanded) setExpanded(importBaseId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setImportError(msg);
      notify(msg, 'err');
    } finally {
      setImportBusy(false);
    }
  };

  const submitSeed = async () => {
    const baseId = seedDraftBase;
    const body = seedBody.trim();
    if (!baseId) { setSeedError(t('Choose a base first')); return; }
    if (!body) { setSeedError(t('Body is required')); return; }
    setSeedBusy(true);
    setSeedError(null);
    try {
      await addKnowledgeSeed(baseId, { title: seedTitle.trim(), body, tags: splitTags(seedTags) });
      setSeedTitle('');
      setSeedBody('');
      setSeedTags('');
      notify(t('Seed added'));
      await load();
      await loadSeeds(baseId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSeedError(msg);
      notify(msg, 'err');
    } finally {
      setSeedBusy(false);
    }
  };

  const submitTags = async (seed: KnowledgeSeedSummary) => {
    const baseId = owners[seed.id];
    if (!baseId) return;
    const value = (tagDraft[seed.id] ?? seed.tags.join(', ')).trim();
    if (value === seed.tags.join(', ')) return;
    setTagBusy((prev) => ({ ...prev, [seed.id]: true }));
    try {
      await retagKnowledgeSeed(baseId, seed.id, splitTags(value));
      notify(t('Tags saved'));
      await loadSeeds(baseId);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setTagBusy((prev) => ({ ...prev, [seed.id]: false }));
    }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearchBusy(true);
    setSearchError(null);
    try {
      const res = await searchKnowledge(q, searchBaseId || undefined);
      setResults(res.hits ?? []);
      setSearchMode(res.mode);
      setSearched(true);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy(false);
    }
  };

  const removeBase = async () => {
    if (!confirmBase) return;
    setDeleting(true);
    try {
      await deleteKnowledgeBase(confirmBase.id);
      notify(t('Base deleted'));
      setConfirmBase(null);
      if (expanded === confirmBase.id) setExpanded(null);
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setDeleting(false);
    }
  };

  const removeSeed = async () => {
    if (!confirmSeed) return;
    setDeleting(true);
    try {
      await deleteKnowledgeSeed(confirmSeed.baseId, confirmSeed.seed.id);
      notify(t('Seed deleted'));
      setConfirmSeed(null);
      await loadSeeds(confirmSeed.baseId);
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setDeleting(false);
    }
  };

  const visibleSeeds = useMemo(() => {
    if (!expanded) return [];
    const list = seeds[expanded] ?? [];
    const q = seedFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => `${s.title} ${s.body} ${s.tags.join(' ')}`.toLowerCase().includes(q));
  }, [expanded, seeds, seedFilter]);

  return (
    <div className="space-y-2">
      <Section title={t('Knowledge bases')}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> {t('New base')}
          </Button>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-text-tertiary start-2.5" />
            <input
              type="text"
              value={baseFilter}
              onChange={(e) => setBaseFilter(e.target.value)}
              placeholder={t('Filter bases')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp ps-8 pe-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </div>
          <span className="shrink-0 rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
            {bases.length} {t('Bases')}
          </span>
        </div>

        {!enabled && (
          <div className="mb-3 flex items-start gap-2 rounded-card border border-border-main bg-fill-tsp p-3 text-xs text-text-secondary">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-function-warning" />
            <p>
              {t('Embedding model is off, so search runs lexically only and new seeds are stored without vectors.')}
            </p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-secondary">
            <Loader2 className="size-4 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 py-4 text-function-error">
            <AlertCircle className="size-4 shrink-0" />
            <p className="text-sm">{t('Failed to load the knowledge garden')} {error}</p>
          </div>
        ) : filteredBases.length === 0 ? (
          <p className="py-4 text-sm text-text-tertiary">{bases.length === 0 ? t('No knowledge bases yet.') : t('No results.')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {filteredBases.map((base) => {
              const isOpen = expanded === base.id;
              return (
                <li key={base.id} className="rounded-card border border-border-main bg-bg-menu">
                  <div className="flex items-start gap-3 p-3">
                    <button
                      type="button"
                      onClick={() => toggle(base.id)}
                      aria-expanded={isOpen}
                      className="mt-1 text-text-tertiary hover:text-text-primary"
                    >
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                    <BookMarked className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary">{base.name}</p>
                      <p className="text-[11px] text-text-tertiary">
                        {base.seeds} {t('seeds')} · {t('updated')} {new Date(base.updatedAt).toLocaleString()}
                      </p>
                      {base.description && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{base.description}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => openImport(base.id)}>
                        <Plus className="size-4" /> {t('Import')}
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setConfirmBase(base)}>
                        <Trash2 className="size-4" /> {t('Delete')}
                      </Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="border-t border-border-main px-4 py-3">
                      {seedsLoading === base.id ? (
                        <div className="flex items-center gap-2 py-2 text-text-secondary">
                          <Loader2 className="size-4 animate-spin" /> {t('Loading seeds')}
                        </div>
                      ) : seedsError ? (
                        <p className="py-2 text-sm text-function-error">{seedsError}</p>
                      ) : (seeds[base.id] ?? []).length === 0 ? (
                        <p className="py-2 text-sm text-text-tertiary">{t('This base is empty. Import text, a file or a URL to fill it.')}</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {(seeds[base.id] ?? []).map((seed) => (
                            <SeedRow
                              key={seed.id}
                              seed={seed}
                              draft={tagDraft[seed.id] ?? seed.tags.join(', ')}
                              busy={Boolean(tagBusy[seed.id])}
                              onDraft={(v) => setTagDraft((prev) => ({ ...prev, [seed.id]: v }))}
                              onTags={() => void submitTags(seed)}
                              onDelete={() => setConfirmSeed({ baseId: base.id, seed })}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={t('Add a seed')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Base')}>
            <select
              value={seedDraftBase}
              onChange={(e) => setSeedDraftBase(e.target.value)}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary"
            >
              <option value="">{t('Choose a base')}</option>
              {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label={t('Title')}>
            <input
              type="text"
              value={seedTitle}
              onChange={(e) => setSeedTitle(e.target.value)}
              placeholder={t('Optional short title')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </Field>
          <Field label={t('Tags')}>
            <input
              type="text"
              value={seedTags}
              onChange={(e) => setSeedTags(e.target.value)}
              placeholder={t('comma, separated')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </Field>
        </div>
        <Field label={t('Body')}>
          <textarea
            value={seedBody}
            onChange={(e) => setSeedBody(e.target.value)}
            placeholder={t('The retrievable text')}
            className="min-h-[140px] w-full rounded-control border border-border-main bg-fill-tsp p-3 text-sm text-text-primary placeholder:text-text-tertiary"
          />
        </Field>
        {seedError && <p className="mb-2 flex items-center gap-1.5 text-sm text-function-error"><AlertCircle className="size-4" /> {seedError}</p>}
        <div className="flex justify-end">
          <Button variant="primary" size="sm" loading={seedBusy} onClick={() => void submitSeed()}>
            <Plus className="size-4" /> {t('Add seed')}
          </Button>
        </div>
      </Section>

      <Section title={t('Search the garden')}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-text-tertiary start-2.5" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
              placeholder={t('Ask the garden')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp ps-8 pe-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </div>
          <select
            value={searchBaseId}
            onChange={(e) => setSearchBaseId(e.target.value)}
            className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary"
          >
            <option value="">{t('All bases')}</option>
            {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <Button variant="primary" size="sm" loading={searchBusy} onClick={() => void runSearch()}>
            <Sparkles className="size-4" /> {t('Search')}
          </Button>
        </div>

        {searchError && <p className="flex items-center gap-1.5 text-sm text-function-error"><AlertCircle className="size-4" /> {searchError}</p>}
        {searched && !searchError && results.length === 0 && (
          <p className="py-3 text-sm text-text-tertiary">{t('No seeds matched that query.')}</p>
        )}
        {results.length > 0 && (
          <>
            <p className="mb-2 text-[11px] text-text-tertiary">
              {searchMode === 'hybrid' ? t('Hybrid (lexical + vector)') : t('Lexical only')} · {results.length} {t('hits')}
            </p>
            <ul className="flex flex-col gap-2">
              {results.map((hit) => (
                <li key={hit.seedId} className="rounded-card border border-border-main bg-bg-menu p-3">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{hit.title}</p>
                    <span className="shrink-0 rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
                      {hit.score.toFixed(3)}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-tertiary">{baseName(hit.baseId)}</p>
                  <p className="mt-1 line-clamp-3 text-xs text-text-secondary">{hit.preview}</p>
                  {hit.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {hit.tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] text-text-tertiary">{tag}</span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={t('New knowledge base')} width={460}>
        <div className="flex flex-col gap-3">
          <Field label={t('Name')}>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t('e.g. Product docs')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </Field>
          <Field label={t('Description')}>
            <input
              type="text"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              placeholder={t('Optional')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </Field>
          {createError && <p className="flex items-center gap-1.5 text-sm text-function-error"><AlertCircle className="size-4" /> {createError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)} disabled={createBusy}>{t('Cancel')}</Button>
            <Button variant="primary" size="sm" loading={createBusy} onClick={() => void submitCreate()}>{t('Create')}</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={importOpen} onClose={() => setImportOpen(false)} title={t('Import into knowledge base')} width={560}>
        <div className="flex flex-col gap-3">
          <Field label={t('Source')}>
            <div className="flex gap-1">
              {(['text', 'file', 'url'] as ImportSource[]).map((src) => (
                <button
                  key={src}
                  type="button"
                  aria-pressed={importSource === src}
                  onClick={() => setImportSource(src)}
                  className={clsx(
                    'h-row-sm rounded-control border px-3 text-sm',
                    importSource === src
                      ? 'border-icon-blue bg-fill-tsp text-icon-blue'
                      : 'border-border-main text-text-secondary hover:bg-fill-hover',
                  )}
                >
                  {src === 'text' ? t('Text') : src === 'file' ? t('File path') : t('URL')}
                </button>
              ))}
            </div>
          </Field>

          {importSource === 'text' && (
            <Field label={t('Text')}>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={t('Paste the text to store')}
                className="min-h-[160px] w-full rounded-control border border-border-main bg-fill-tsp p-3 text-sm text-text-primary placeholder:text-text-tertiary"
              />
            </Field>
          )}
          {importSource === 'file' && (
            <Field label={t('Workspace-relative path')}>
              <input
                type="text"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                placeholder="docs/spec.md"
                className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 font-mono text-xs text-text-primary placeholder:text-text-tertiary"
              />
            </Field>
          )}
          {importSource === 'url' && (
            <Field label={t('URL')}>
              <input
                type="text"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://example.com/article"
                className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 font-mono text-xs text-text-primary placeholder:text-text-tertiary"
              />
            </Field>
          )}

          <Field label={t('Tags')}>
            <input
              type="text"
              value={importTags}
              onChange={(e) => setImportTags(e.target.value)}
              placeholder={t('comma, separated')}
              className="h-row-sm w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary placeholder:text-text-tertiary"
            />
          </Field>

          {importError && <p className="flex items-center gap-1.5 text-sm text-function-error"><AlertCircle className="size-4" /> {importError}</p>}
          {importWarnings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {importWarnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5 text-xs text-function-warning">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(false)} disabled={importBusy}>{t('Cancel')}</Button>
            <Button variant="primary" size="sm" loading={importBusy} onClick={() => void submitImport()}>
              {t('Import')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={confirmBase !== null} onClose={() => setConfirmBase(null)} title={t('Delete knowledge base?')} width={420}>
        <p className="mb-4 text-sm text-text-secondary">
          {t('This deletes the base and every seed in it. This cannot be undone.')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmBase(null)}>{t('Cancel')}</Button>
          <Button variant="danger" size="sm" loading={deleting} onClick={() => void removeBase()}>{t('Delete')}</Button>
        </div>
      </Dialog>

      <Dialog open={confirmSeed !== null} onClose={() => setConfirmSeed(null)} title={t('Delete seed?')} width={420}>
        <p className="mb-4 text-sm text-text-secondary">
          {t('This removes the seed from the base. This cannot be undone.')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmSeed(null)}>{t('Cancel')}</Button>
          <Button variant="danger" size="sm" loading={deleting} onClick={() => void removeSeed()}>{t('Delete')}</Button>
        </div>
      </Dialog>

      {toast && (
        <div className="fixed bottom-5 start-5 z-[70]">
          <div className={clsx(
            'max-w-[420px] rounded-card px-3.5 py-2.5 text-sm shadow-layer',
            toast.kind === 'ok' ? 'bg-function-success text-white' : 'bg-function-error text-white',
          )}>
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}

function SeedRow({
  seed, draft, busy, onDraft, onTags, onDelete,
}: {
  seed: KnowledgeSeedSummary;
  draft: string;
  busy: boolean;
  onDraft: (v: string) => void;
  onTags: () => void;
  onDelete: () => void;
}) {
  const dirty = draft.trim() !== seed.tags.join(', ');
  return (
    <li className="rounded-control border border-border-main bg-fill-tsp p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">{seed.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{seed.body}</p>
          {seed.provenance && (
            <p className="mt-1 text-[10px] text-text-tertiary">
              {seed.provenance.source}{seed.provenance.ref ? ` · ${seed.provenance.ref}` : ''}
              {seed.smartSplit ? ' · smart split' : ''}
            </p>
          )}
        </div>
        <Button variant="danger" size="sm" onClick={onDelete}><Trash2 className="size-4" /></Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Tag className="size-3.5 shrink-0 text-text-tertiary" />
        <input
          type="text"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded-control border border-border-main bg-bg-menu px-2 text-xs text-text-primary"
        />
        <Button variant="ghost" size="sm" disabled={busy || !dirty} onClick={onTags}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        </Button>
      </div>
    </li>
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

function splitTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
