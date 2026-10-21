'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Check, KeyRound, Loader2, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { fetchFlexConfig, saveFlexConfig, removeFlexKey, type FlexConfig } from '@/services/modelTiersApi';

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

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-control px-2 py-1 text-sm font-medium text-text-primary hover:bg-fill-hover"
      >
        {t(selected.titleKey)}
        <ChevronDown className={clsx('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute start-0 top-full z-50 mt-1 w-[366px] max-w-[calc(100vw-32px)] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg">
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
          {value === 'flex' && <FlexForm onClose={() => setOpen(false)} />}
        </div>
      )}
    </div>
  );
}

/** Option 18 Flex (BYOK): the key is stored encrypted in the Loam secrets
 *  vault and is never fetched or displayed; leave it blank to keep it. */
function FlexForm({ onClose }: { onClose: () => void }) {
  const [flex, setFlex] = useState<FlexConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
