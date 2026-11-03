'use client';

/**
 * The real model picker — the only model menu content since the fictional
 * "Loam 2.0 Max/Lite" tiers were removed (the product ships no models of its
 * own; every run goes through Ollama, a cloud provider, a self-hosted router
 * like freellmapi, or the registry's native Anthropic/Gemini adapters).
 *
 * Two surfaces mount this (home hero composer + chat composer); both keep
 * their tier plumbing for persistence — picks fire onTier('standard') for
 * local models and onTier('flex') for cloud/BYOK picks.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, KeyRound, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import {
  fetchFlexConfig, saveFlexConfig, removeFlexKey,
  fetchModelDirectory, selectModel, rememberRunModel, rememberedRunModel, displayModelId,
  type FlexConfig, type ModelDirectory, type ProviderPreset,
} from '@/services/modelTiersApi';

export type PickTier = 'standard' | 'flex';

/** Shared trigger label + directory state for both menus. */
export function useModelDirectory() {
  const [directory, setDirectory] = useState<ModelDirectory | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState('');
  useEffect(() => {
    let mounted = true;
    fetchModelDirectory().then((data) => {
      if (!mounted) return;
      if (data) setDirectory(data);
      else setFailed(true);
    });
    const onPick = () => setPicked(rememberedRunModel());
    onPick();
    window.addEventListener('loam-run-model', onPick);
    return () => { mounted = false; window.removeEventListener('loam-run-model', onPick); };
  }, []);
  const saved = directory
    ? (directory.active.settingsModel || directory.active.flex.model || directory.active.model)
    : '';
  const activeId = displayModelId(picked || saved);
  return { directory, failed, activeId };
}

export function RealModelPicker({ onTier, forceFlexForm = false }: {
  onTier: (tier: PickTier) => void;
  forceFlexForm?: boolean;
}) {
  const { directory, failed, activeId } = useModelDirectory();
  const [showFlex, setShowFlex] = useState(forceFlexForm);

  return (
    <div>
      <RealModels
        directory={directory}
        failed={failed}
        activeId={activeId}
        onPicked={onTier}
      />
      {!forceFlexForm && (
        <button
          type="button"
          onClick={() => setShowFlex((v) => !v)}
          className="flex w-full items-center gap-2 rounded-control border-t border-border-main px-3 py-2 text-start text-xs text-text-secondary hover:bg-fill-hover"
        >
          <Plus className="size-3.5" aria-hidden />
          {t('Custom provider (Flex)')}
        </button>
      )}
      {(showFlex || forceFlexForm) && (
        <FlexForm
          presets={directory?.presets ?? []}
          onSaved={() => onTier('flex')}
        />
      )}
    </div>
  );
}

/** Every model actually reachable now, grouped by source with a search box. */
function RealModels({ directory, failed, activeId, onPicked }: {
  directory: ModelDirectory | null;
  failed: boolean;
  activeId: string;
  onPicked: (tier: PickTier) => void;
}) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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
    return directory.sources.map((source) => ({ source, models: bySource.get(source.source) ?? [] }));
  }, [directory, query]);

  // The menu sits on the bottom composer and opens upward. Keep the list
  // pinned to the first models; scroll anchoring otherwise jumps to the end
  // whenever the directory arrives or the selection re-renders.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = 0;
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
    rememberRunModel(result.model);
    setNeedsKey(result.needsKey);
    onPicked(result.tier);
  };

  return (
    <div>
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
      <div ref={listRef} className="max-h-64 min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
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

/** BYOK (Flex): the key is sealed in the Loam vault and never echoed back;
 *  preset chips (freellmapi first) fill the base URL with setup hints. */
export function FlexForm({ presets, onSaved }: { presets: ProviderPreset[]; onSaved?: () => void }) {
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
      onSaved?.();
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
    <form onSubmit={save} className="border-t border-border-main px-3 pb-2 pt-2">
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
      </div>
    </form>
  );
}
