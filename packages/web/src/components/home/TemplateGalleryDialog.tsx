'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { t } from '@/i18n/t';

export interface GalleryTemplate {
  category: string;
  title: string;
  prompt: string;
  icon?: string;
  image?: string;
}

/**
 * Template gallery (home option #16): ~24 templates from /templates.json
 * with search and category filter; selecting one pre-fills the composer.
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
  const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    fetch('/templates.json')
      .then(async (res) => (res.ok ? ((await res.json()) as GalleryTemplate[]) : []))
      .then((data) => {
        if (mounted && Array.isArray(data)) setTemplates(data);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [open]);

  useEffect(() => {
    if (!open) { setQuery(''); setCategory(null); }
  }, [open]);

  const categories = useMemo(
    () => [...new Set(templates.map((tpl) => tpl.category).filter(Boolean))],
    [templates],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (category && tpl.category !== category) return false;
      if (!q) return true;
      return tpl.title.toLowerCase().includes(q) || tpl.prompt.toLowerCase().includes(q);
    });
  }, [templates, category, query]);

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
        <div className="flex flex-col gap-3 px-5 pb-3 pt-4">
          <h2 className="text-base font-semibold text-text-primary">{t('Template gallery')}</h2>
          <div className="flex items-center gap-2 rounded-control border border-border-main px-3 py-2">
            <Search className="size-4 text-text-tertiary" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Search templates...')}
              className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setCategory(null)}
              className={`rounded-full px-3 py-1 text-xs ${category === null ? 'bg-text-primary text-text-onblack' : 'border border-border-main text-text-secondary hover:bg-fill-hover'}`}
            >
              {t('All')}
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory((prev) => (prev === cat ? null : cat))}
                className={`rounded-full px-3 py-1 text-xs ${category === cat ? 'bg-text-primary text-text-onblack' : 'border border-border-main text-text-secondary hover:bg-fill-hover'}`}
              >
                {t(cat)}
              </button>
            ))}
          </div>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-2 overflow-y-auto px-5 pb-5 sm:grid-cols-3">
          {filtered.length === 0 && (
            <p className="col-span-full py-10 text-center text-sm text-text-tertiary">{t('No results')}</p>
          )}
          {filtered.map((tpl) => (
            <button
              key={`${tpl.category}-${tpl.title}`}
              type="button"
              onClick={() => { onSelect(tpl); onClose(); }}
              className="flex flex-col gap-1 rounded-card border border-border-main p-3 text-start transition-colors hover:bg-fill-hover"
            >
              <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                {tpl.icon && <span aria-hidden>{tpl.icon}</span>}
                {t(tpl.category)}
              </span>
              <span className="truncate text-[13px] font-medium text-text-primary">{t(tpl.title)}</span>
              <span className="line-clamp-2 text-[11px] leading-snug text-text-tertiary">{tpl.prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
