'use client';

import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react';

export interface StarterItem {
  label: string;
  prompt: string;
  icon?: string;
  loamMode?: string;
}

interface StarterMenuProps {
  items: StarterItem[];
  children: ReactElement<{ onClick?: () => void; 'aria-expanded'?: boolean; 'aria-haspopup'?: boolean }>;
  onSelect: (item: StarterItem) => void;
}

export function StarterMenu({ items, children, onSelect }: StarterMenuProps) {
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

  return (
    <div className="relative" ref={ref}>
      {cloneElement(children, {
        onClick: () => setOpen((v) => !v),
        'aria-expanded': open,
        'aria-haspopup': true,
      })}
      {open && (
        <div
          role="menu"
          aria-orientation="vertical"
          className="absolute start-0 top-full z-40 mt-1 min-w-[200px] max-w-[calc(100vw-32px)] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => { onSelect(item); setOpen(false); }}
              className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm text-text-primary hover:bg-fill-hover"
            >
              {item.icon && <span className="text-base" aria-hidden>{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
