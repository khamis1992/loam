'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';

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
        </div>
      )}
    </div>
  );
}
