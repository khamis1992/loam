'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Play, Search, X } from 'lucide-react';
import { t } from '@/i18n/t';
import { flowTemplateHref, listFlowTemplates, type FlowTemplate } from '@/services/flowTemplatesApi';

/** Folded (lowercase, diacritic-stripped) text for the gallery search box. */
function foldText(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * The catalog already ships one label per Loam mode (Build/Write/Data/Media/
 * Research/Security/Automate) in `src/components/chat/modeLabels.ts`. The card
 * reuses those keys so the mode badge and the mode chip read identically,
 * rather than inventing a second set of mode strings here.
 */
const MODE_LABEL_KEYS: Record<string, string> = {
  build: 'Build',
  write: 'Write',
  data: 'Data',
  media: 'Media',
  research: 'Research',
  security: 'Security',
  automate: 'Automate',
};

function modeLabel(mode: string): string {
  return MODE_LABEL_KEYS[mode] ?? mode;
}

function flowCategories(flows: FlowTemplate[]): string[] {
  const seen = new Set<string>();
  for (const flow of flows) if (flow.category) seen.add(flow.category);
  return [...seen].sort();
}

function filterFlows(flows: FlowTemplate[], query: string, category: string | null): FlowTemplate[] {
  const needle = foldText(query.trim());
  return flows.filter((flow) => {
    if (category && flow.category !== category) return false;
    if (!needle) return true;
    return foldText(`${flow.title} ${flow.description} ${flow.prompt}`).includes(needle);
  });
}

/**
 * Case Playbook (Neo N15): the seeded gallery of 12 Loam flows. Each card's
 * "Try this flow" button opens a deep link that pre-fills the composer prompt,
 * Loam mode, output type and effort.
 */
export function FlowPlaybook({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [flows, setFlows] = useState<FlowTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listFlowTemplates()
      .then((data) => { if (!cancelled) { setFlows(data.flows); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const categories = useMemo(() => (flows ? flowCategories(flows) : []), [flows]);
  const filtered = useMemo(() => (flows ? filterFlows(flows, query, category) : []), [flows, query, category]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('Case Playbook')}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[760px] max-w-full flex-col overflow-hidden rounded-[20px] bg-bg-menu shadow-menu"
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('Case Playbook')}</h2>
            <p className="text-xs text-text-tertiary">{t('Twelve ready Loam flows. Pick one to start from a proven prompt.')}</p>
          </div>
          <button
            type="button"
            aria-label={t('Close')}
            onClick={onClose}
            className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 pb-3">
          <div className="flex items-center gap-2 rounded-control border border-border-main px-3 py-2">
            <Search className="size-4 text-text-tertiary" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Search flows...')}
              aria-label={t('Search flows...')}
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
          {error && <p className="col-span-full py-10 text-center text-sm text-function-error">{error}</p>}
          {!flows && !error && (
            <p className="col-span-full flex items-center justify-center gap-2 py-10 text-sm text-text-tertiary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </p>
          )}
          {flows && filtered.length === 0 && (
            <p className="col-span-full py-10 text-center text-sm text-text-tertiary">{t('No results')}</p>
          )}
          {filtered.map((flow) => (
            <div
              key={flow.id}
              className="flex flex-col gap-1.5 rounded-card border border-border-main p-3 transition-colors hover:bg-fill-hover"
            >
              <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                {flow.icon && <span aria-hidden>{flow.icon}</span>}
                {flow.category ? t(flow.category) : t('Flow')}
                <span className="ms-auto rounded-control bg-fill-tsp px-1.5 py-0.5 text-[10px] text-text-secondary">
                  {t(flow.mode === 'ask' ? 'Ask' : modeLabel(flow.mode))} · {t(flow.effort === 'fast' ? 'Fast' : 'Max')}
                </span>
              </span>
              <span className="truncate text-[13px] font-medium text-text-primary">{flow.title}</span>
              <span className="line-clamp-2 min-h-[2rem] text-[11px] leading-snug text-text-tertiary">{flow.description}</span>
              <button
                type="button"
                onClick={() => {
                  window.location.href = flowTemplateHref(flow);
                  onClose();
                }}
                className="mt-auto flex items-center justify-center gap-1.5 rounded-control bg-text-primary px-2 py-1.5 text-xs font-medium text-text-onblack"
              >
                <Play className="size-3" aria-hidden />
                {t('Try this flow')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
