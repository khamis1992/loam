'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { t, getLocale, PRODUCT } from '@/i18n/t';
import { dedupeBrandLabel, LOAM_MODES, type ModeChipResolved } from './modeLabels';

export type { ModeChipResolved } from './modeLabels';

interface ModeChipProps {
  resolved?: ModeChipResolved | null;
  value?: string;
  onChange?: (mode: string) => void;
}

export function ModeChip({ resolved, value, onChange }: ModeChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentLabel = () => {
    if (value) {
      const option = LOAM_MODES.find((m) => m.value === value);
      return option ? t(option.label) : value;
    }
    if (resolved) {
      return getLocale() === 'ar' ? resolved.labelAr : resolved.label;
    }
    return t('Standard');
  };

  const label = currentLabel();
  const hasMode = !!(value || resolved);
  const rawLabel = label.startsWith(PRODUCT) ? label : label && label !== PRODUCT ? label : t('Standard');
  const displayLabel = dedupeBrandLabel(rawLabel);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={clsx(
          'flex h-row-sm items-center gap-1 rounded-control border border-border-main px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-fill-hover',
          value && 'text-text-primary',
        )}
      >
        {!hasMode && <span className="text-icon-blue">{PRODUCT}</span>}
        <span className="max-w-[120px] truncate">{displayLabel}</span>
        <ChevronDown className={clsx('size-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t('Loam mode')}
          className="absolute bottom-full end-0 z-50 mb-1 min-w-[160px] max-w-[calc(100vw-32px)] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg"
        >
          {LOAM_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={value === m.value}
              onClick={() => {
                onChange?.(m.value);
                setOpen(false);
              }}
              className={clsx(
                'flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover',
                value === m.value && 'bg-fill-hover',
              )}
            >
              <span className={clsx('size-2 rounded-full', value === m.value ? 'bg-icon-blue' : 'bg-transparent')} />
              {t(m.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
