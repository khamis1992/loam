import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/i18n/t';

export function Dialog({ open, onClose, title, children, width = 480 }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        style={{ width }}
        className="max-h-[85vh] overflow-auto rounded-card bg-bg-menu p-6 shadow-layer outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-title-lg text-text-primary">{title}</h2>
          <button aria-label={t('Close')} onClick={onClose} className="rounded-control p-1 hover:bg-fill-hover">✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
