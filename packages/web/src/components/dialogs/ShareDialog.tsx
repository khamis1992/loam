'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Check, X } from 'lucide-react';
import { t } from '@/i18n/t';

export function ShareDialog({ open, onClose, url }: { open: boolean; onClose: () => void; url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      setToast(false);
    }
  }, [open]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setToast(true);
      setTimeout(() => setCopied(false), 2000);
      setTimeout(() => setToast(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={t('Share')} tabIndex={-1}
        className="relative w-[420px] rounded-card bg-bg-menu p-6 shadow-menu outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-title-lg text-text-primary">{t('Share')}</h2>
          <button type="button" aria-label={t('Close')} onClick={onClose} className="rounded-control p-1 text-text-secondary hover:bg-fill-hover">
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-3 text-sm text-text-secondary">{t('Copy the link to this task to share it.')}</p>
        <div className="flex items-center gap-2 rounded-control border border-border-main bg-fill-tsp px-3 py-2">
          <Link2 className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          <input
            readOnly
            value={url}
            className="flex-1 bg-transparent text-sm text-text-primary outline-none"
            onFocus={(e) => e.target.select()}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={copy}
            className="inline-flex h-row items-center gap-1.5 rounded-control bg-text-primary px-3 text-sm text-text-onblack hover:opacity-90"
          >
            {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
            {copied ? t('Copied') : t('Copy link')}
          </button>
        </div>
        {toast && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-control bg-function-success px-3 py-1.5 text-sm text-white shadow-menu">
            {t('Link copied')}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
