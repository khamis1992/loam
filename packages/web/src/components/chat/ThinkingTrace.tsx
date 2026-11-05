'use client';

import { useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/t';

/** Quiet reasoning block: a "Thinking" label, with the model's trace behind it. */
export function ThinkingTrace({ text, active }: { text: string; active: boolean }) {
  const trace = text.trim();
  const hasTrace = trace.length > 0 && trace !== 'Thinking';
  const [open, setOpen] = useState(false);
  const closedByUser = useRef(false);

  useEffect(() => {
    if (!active) {
      closedByUser.current = false;
      setOpen(false);
      return;
    }
    if (hasTrace && !closedByUser.current) setOpen(true);
  }, [active, hasTrace]);

  if (!active && !hasTrace) return null;

  return (
    <div className="mb-2 text-sm text-text-tertiary">
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-text-secondary"
        aria-expanded={hasTrace ? open : undefined}
        onClick={() => {
          if (!hasTrace) return;
          setOpen((value) => {
            closedByUser.current = value;
            return !value;
          });
        }}
      >
        <span>{t('Thinking')}</span>
        {hasTrace ? <span aria-hidden="true">{open ? '▾' : '▸'}</span> : null}
        {active && !hasTrace ? <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" /> : null}
      </button>
      {open && hasTrace ? (
        <div dir="auto" className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap border-s border-border-main ps-3 text-[13px] leading-6">
          {trace}
        </div>
      ) : null}
    </div>
  );
}
