'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/i18n/t';
import { TemplateGallery } from './TemplateGallery';
import type { GalleryTemplate } from './templates';

export type { GalleryTemplate } from './templates';

/**
 * Template gallery dialog (home option #16): thin portal shell around the
 * TemplateGallery component, which is backed by the static templates data
 * module (no fetch, no backend). Selecting a template is delegated to
 * `onSelect` — the Home page pre-fills the composer prompt with it.
 */
export function TemplateGalleryDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (template: GalleryTemplate) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('Template gallery')}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[720px] max-w-full flex-col overflow-hidden rounded-[20px] bg-bg-menu shadow-menu"
      >
        <TemplateGallery
          onSelect={(template) => {
            onSelect(template);
            onClose();
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
