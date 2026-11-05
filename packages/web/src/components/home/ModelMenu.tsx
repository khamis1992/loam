'use client';

/**
 * Model menu (home composer). The fictional "Loam 2.0 Max/Lite" tiers were
 * removed — Loam ships no models of its own, so the menu IS the real picker:
 * every reachable model (Ollama local, cloud providers, the freellmapi
 * router, the registry incl. native Anthropic/Gemini), plus the Flex BYOK
 * form behind the "custom provider" row.
 *
 * The AgentModel tier value stays as the persistence contract (picks resolve
 * to 'standard' for local models and 'flex' for cloud/BYOK picks).
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { RealModelPicker, useModelDirectory } from '@/components/model-menu/RealModelPicker';

export type AgentModel = 'max' | 'standard' | 'lite' | 'flex';

interface ModelMenuProps {
  value: AgentModel;
  onChange: (value: AgentModel) => void;
}

export function ModelMenu({ value, onChange }: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { activeId } = useModelDirectory();

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
        {activeId
          ? <span className="max-w-[180px] truncate" title={activeId}>{activeId}</span>
          : t('Model')}
        <ChevronDown className={clsx('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute start-0 top-full z-50 mt-1 w-[366px] max-w-[calc(100vw-32px)] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg">
          <RealModelPicker
            onTier={(tier, opts) => {
              onChange(tier);
              if (!opts?.keepOpen) setOpen(false);
            }}
            forceFlexForm={value === 'flex'}
          />
        </div>
      )}
    </div>
  );
}
