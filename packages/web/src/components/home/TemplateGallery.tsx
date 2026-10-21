'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import { Search } from 'lucide-react';
import { t } from '@/i18n/t';
import { TEMPLATES, type GalleryTemplate } from './templates';
import { filterTemplates, templateCategories } from './templateGalleryFilter';

/**
 * Template gallery (home option #16): every template beyond the 3 cards on
 * Home, backed by the static `templates` data module. Selecting a card calls
 * `onSelect(template)` so the host can pre-fill the composer prompt.
 */
export function TemplateGallery({
  templates = TEMPLATES,
  onSelect,
}: {
  templates?: GalleryTemplate[];
  onSelect: (template: GalleryTemplate) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const categories = useMemo(() => templateCategories(templates), [templates]);
  const filtered = useMemo(
    () => filterTemplates(templates, { query, category }),
    [templates, query, category],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 px-5 pb-3 pt-4">
        <h2 className="text-base font-semibold text-text-primary">{t('Template gallery')}</h2>
        <div className="flex items-center gap-2 rounded-control border border-border-main px-3 py-2">
          <Search className="size-4 text-text-tertiary" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search templates...')}
            aria-label={t('Search templates...')}
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
            onClick={() => onSelect(tpl)}
            className="flex flex-col gap-1 rounded-card border border-border-main p-3 text-start transition-colors hover:bg-fill-hover"
          >
            {tpl.image && (
              <span className="relative mb-1 block h-20 w-full overflow-hidden rounded">
                <Image
                  src={tpl.image}
                  alt={t(tpl.title)}
                  fill
                  sizes="(max-width: 768px) 50vw, 240px"
                  className="object-cover"
                  unoptimized
                />
              </span>
            )}
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
  );
}
