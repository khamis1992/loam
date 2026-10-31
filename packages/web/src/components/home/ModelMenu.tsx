'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Check, KeyRound, Loader2, Trash2, Search } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import {
  fetchFlexConfig, saveFlexConfig, removeFlexKey,
  fetchModelDirectory, selectModel,
  type FlexConfig, type ModelDirectory, type ProviderPreset,
} from '@/services/modelTiersApi';

export type AgentModel = 'max' | 'standard' | 'lite' | 'flex';

interface ModelItem {
  id: AgentModel;
  titleKey: string;
  descKey: string;
}

const ITEMS: ModelItem[] = [
  { id: 'max', titleKey: '{product} 2.0 Max', descKey: 'High-performance agent designed for complex tasks.' },
  { id: 'standard', titleKey: '{product} 2.0', descKey: 'Versatile agent capable of most tasks.' },
  { id: 'lite', titleKey: '{product} 2.0 Lite', descKey: 'A lightweight agent for everyday tasks.' },
  { id: 'flex', titleKey: '{product} Flex', descKey: 'Bring your own model API key to power {product}.' },
];

interface ModelMenuProps {
  value: AgentModel;
  onChange: (value: AgentModel) => void;
}

export function ModelMenu({ value, onChange }: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<ModelDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = ITEMS.find((i) => i.id === value) ?? ITEMS[1];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Real model directory: fetched once on mount (so the trigger button shows
  // the effective model before the menu is ever opened) and again whenever the
  // menu opens while nothing is cached — a provider that just came up appears
  // on the next mount/open. Failure degrades to the tiers-only menu.
  useEffect(() => {
    if (directory || directoryError) return;
    let mounted = true;
    fetchModelDirectory().then((data) => {
      if (!mounted) return;
      if (data) setDirectory(data);
      else setDirectoryError(true);
    });
    return () => { mounted = false; };
  }, [open, directory, directoryError]);

  const activeModelId = directory
    ? (value === 'flex'
        ? directory.active.flex.model
        : directory.active.settingsModel || stripCloud(directory.active.model))
    : '';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-control px-2 py-1 text-sm font-medium text-text-primary hover:bg-fill-hover"
      >
        {activeModelId
          ? <span className="max-w-[180px] truncate" title={activeModelId}>{activeModelId}</span>
          : t(selected.titleKey)}
        <ChevronDown className={clsx('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute start-0 top-full z-50 mt-1 w-[366px] max-w-[calc(100vw-32px)] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg">
          <RealModels
            directory={directory}
            failed={directoryError}
            activeId={activeModelId}
            onPicked={(tier) => onChange(tier)}
          />
          {ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { onChange(item.id); setOpen(false); }}
              className="flex w-full items-center gap-3 rounded-control px-3 py-2 text-start hover:bg-fill-hover"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary">{t(item.titleKey)}</p>
                <p className="text-xs text-text-tertiary">{t(item.descKey)}</p>
              </div>
              {value === item.id && <Check className="size-4 shrink-0 text-text-primary" aria-hidden />}
            </button>
          ))}
          {value === 'flex' && <FlexForm onClose={() => setOpen(false)} presets={directory?.presets ?? []} />}
        </div>
      )}
    </div>
  );
}

function stripCloud(id: string): string {
  return id.endsWith(':cloud') ? id.slice(0, -':cloud'.length) : id;
}

/** Real models section: every model actually reachable now (Ollama local,
 *  cloud providers, the freellmapi router), grouped by source with a search
 *  box. Picking one routes new tasks through it. */
function RealModels({ directory, failed, activeId, onPicked }: {
  directory: ModelDirectory | null;
  failed: boolean;
  activeId: string;
  onPicked: (tier: 'standard' | 'flex') => void;
}) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);

  const groups = useMemo(() => {
    if (!directory) return [] as Array<{ source: ModelDirectory['sources'][number]; models: ModelDirectory['models'][number][] }>;
    const q = query.trim().toLowerCase();
    const bySource = new Map<string, ModelDirectory['models'][number][]>();
    for (const model of directory.models) {
      if (q && !model.id.toLowerCase().includes(q)) continue;
      const list = bySource.get(model.source) ?? [];
      list.push(model);
      bySource.set(model.source, list);
    }
    // Keep the server's source order; unreachable sources still show (dimmed,
    // with their error) so the user knows what to start.
    return directory.sources.map((source) => ({ source, models: bySource.get(source.source) ?? [] }));
  }, [directory, query]);

  if (failed) return null;
  if (!directory) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-tertiary">
        <Loader2 className="size-3.5 animate-spin" /> {t('Loading models…')}
      </div>
    );
  }

  const pick = async (id: string, source: string) => {
    setBusyId(`${source}::${id}`);
    setError(null);
    const result = await selectModel({ id, source });
    setBusyId(null);
    if ('error' in result) { setError(result.error); return; }
    setNeedsKey(result.needsKey);
    onPicked(result.tier);
  };

  return (
    <div className="border-b border-border-main">
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
        <Search className="size-3.5 shrink-0 text-text-tertiary" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search models (Ollama / cloud / freellmapi)…')}
          className="w-full rounded-control border border-border-main bg-bg-main px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {groups.map(({ source, models }) => (
          <div key={source.source} className="px-1 pb-1">
            <p className={clsx('px-2 py-1 text-[10px] font-medium uppercase tracking-wide', source.error ? 'text-func-error' : 'text-text-tertiary')}>
              {source.label}
              {source.error ? ` — ${t('unreachable')}` : ` (${models.length})`}
            </p>
            {models.map((model) => {
              const key = `${model.source}::${model.id}`;
              const isActive = activeId === model.id;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => { void pick(model.id, model.source); }}
                  className="flex w-full items-center gap-2 rounded-control px-2 py-1 text-start hover:bg-fill-hover disabled:opacity-50"
                  title={source.baseUrl ? `${source.baseUrl} · ${model.id}` : model.id}
                >
                  <span className={clsx('size-1.5 shrink-0 rounded-full', model.kind === 'ollama' ? 'bg-func-success' : 'bg-accent-blue')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{model.id}</span>
                  {busyId === key && <Loader2 className="size-3 animate-spin" />}
                  {isActive && <Check className="size-3.5 shrink-0 text-text-primary" aria-hidden />}
                </button>
              );
            })}
          </div>
        ))}
        {directory.models.length === 0 && (
          <p className="px-3 py-2 text-xs text-text-tertiary">{t('No models found. Start Ollama or configure a provider.')}</p>
        )}
      </div>
      {needsKey && (
        <p className="px-3 pb-1.5 text-[11px] text-func-error">{t('Model selected, but it needs an API key — add it under Flex below.')}</p>
      )}
      {error && <p className="px-3 pb-1.5 text-[11px] text-func-error">{error}</p>}
    </div>
  );
}

/** Option 18 Flex (BYOK): the key is stored encrypted in the Loam secrets
 *  vault and is never fetched or displayed; leave it blank to keep it.
 *  `presets` fills the base URL with one tap (freellmapi first). */
function FlexForm({ onClose, presets }: { onClose: () => void; presets: ProviderPreset[] }) {
  const [flex, setFlex] = useState<FlexConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchFlexConfig().then((data) => {
      if (!mounted || !data) return;
      setFlex(data);
      setBaseUrl(data.baseUrl);
      setModel(data.model);
    });
    return () => { mounted = false; };
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await saveFlexConfig({ baseUrl, model, key });
      if (result.error) throw new Error(result.error);
      setKey('');
      if (result.flex) setFlex(result.flex);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await removeFlexKey();
      if (result.error) throw new Error(result.error);
      if (result.flex) setFlex(result.flex);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="mt-1 border-t border-border-main px-3 pb-2 pt-2">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary">
        <KeyRound className="size-3.5" />
        {t('Bring your own key')}
        {flex?.hasKey && (
          <span className="ms-auto rounded-full bg-fill-tsp px-2 py-0.5 text-[10px] font-medium text-func-success">
            {t('Key saved')}
          </span>
        )}
      </p>
      <input
        type="text"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={t('Provider base URL (https://...)')}
        className="mb-1.5 w-full rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary"
      />
      {presets.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => { setBaseUrl(preset.baseUrl); setHint(preset.keyEnv ? `${preset.setupAr} (${preset.keyEnv})` : preset.setupAr); }}
              title={preset.setupAr}
              className={clsx(
                'rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                baseUrl === preset.baseUrl
                  ? 'border-accent-blue bg-fill-tsp text-text-primary'
                  : 'border-border-main text-text-tertiary hover:bg-fill-hover',
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
      <input
        type="text"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder={t('Model id')}
        className="mb-1.5 w-full rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary"
      />
      <input
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={flex?.hasKey ? t('New key (blank keeps current)') : t('API key')}
        className="mb-1.5 w-full rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary"
      />
      {hint && <p className="mb-1.5 text-[11px] text-text-tertiary">{hint}</p>}
      {error && <p className="mb-1.5 text-[11px] text-func-error">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !baseUrl.trim() || !model.trim()}
          className="flex items-center gap-1 rounded-control bg-fill-hover px-2.5 py-1 text-xs font-medium text-text-primary disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {t('Save')}
        </button>
        {flex?.hasKey && (
          <button
            type="button"
            disabled={busy}
            onClick={removeKey}
            className="flex items-center gap-1 rounded-control px-2 py-1 text-xs text-func-error hover:bg-fill-hover"
          >
            <Trash2 className="size-3" /> {t('Remove key')}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ms-auto rounded-control px-2 py-1 text-xs text-text-tertiary hover:bg-fill-hover"
        >
          {t('Close')}
        </button>
      </div>
    </form>
  );
}
