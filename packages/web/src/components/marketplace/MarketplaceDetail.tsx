'use client';

/**
 * Marketplace detail side-sheet (MARKETPLACE_SPEC §3.2).
 *
 * Opens from a bot card or row. Drop-in replacement for the inline detail
 * panel in `app/app/marketplace/MarketplacePageClient.tsx`: the props match
 * that call-site one-to-one, except `catalog` is optional — when omitted the
 * component fetches the bundled catalog itself so Related bots work anywhere.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { t } from '@/i18n/t';
import {
  composedInstructions,
  formatAdds,
  isMarketplaceCatalogEntry,
  MARKETPLACE_CATALOG_URL,
  marketplaceAuthorLine,
  marketplaceCategoryColor,
  marketplaceToolLabel,
  type MarketplaceCatalogEntry,
} from './types';
import './marketplace.css';

export interface MarketplaceDetailProps {
  entry: MarketplaceCatalogEntry;
  /** Full catalog for Related bots; fetched from catalog.json when omitted. */
  catalog?: MarketplaceCatalogEntry[];
  /** Agent id when this bot is already installed (Added state). */
  installedAgentId?: string;
  /** True while the Add request is in flight (pending state). */
  pending?: boolean;
  onClose: () => void;
  onAdd?: (entry: MarketplaceCatalogEntry) => void;
  onOpenAgent?: (agentId: string) => void;
  onOpenEntry?: (entry: MarketplaceCatalogEntry) => void;
}

export default function MarketplaceDetail({
  entry,
  catalog,
  installedAgentId,
  pending = false,
  onClose,
  onAdd,
  onOpenAgent,
  onOpenEntry,
}: MarketplaceDetailProps) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const [catalogEntries, setCatalogEntries] = useState<MarketplaceCatalogEntry[] | null>(catalog ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!entry.id) return;
    sheetRef.current?.scrollTo?.({ top: 0 });
  }, [entry.id]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (catalog) {
      setCatalogEntries(catalog);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(MARKETPLACE_CATALOG_URL);
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (!cancelled && Array.isArray(data)) setCatalogEntries(data.filter(isMarketplaceCatalogEntry));
      } catch {
        /* related bots stay hidden when the catalog cannot be loaded */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  const color = marketplaceCategoryColor(entry.category);
  const instructions = useMemo(() => composedInstructions(entry), [entry]);

  const related = useMemo(() => {
    if (!catalogEntries) return [];
    const suggestions = catalogEntries.filter(
      (item) => item.id !== entry.id && item.category === entry.category,
    );
    if (suggestions.length < 3) {
      const chosen = new Set(suggestions.map((item) => item.id));
      const others = catalogEntries
        .filter((item) => item.id !== entry.id && !chosen.has(item.id))
        .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name));
      for (const item of others) {
        if (suggestions.length >= 3) break;
        suggestions.push(item);
      }
    }
    return suggestions.slice(0, 3);
  }, [catalogEntries, entry.id, entry.category]);

  const copyPrompt = async () => {
    const text = instructions;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand('copy');
        document.body.removeChild(area);
      } catch {
        ok = false;
      }
    }
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t('Close')}
        onClick={onClose}
        className="mp-fade-in absolute inset-0 bg-black/30"
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={entry.name}
        tabIndex={-1}
        className="mp-sheet-in mp-scroll absolute inset-y-0 end-0 flex h-full w-full max-w-[720px] flex-col overflow-y-auto border-s border-border-main bg-bg-menu p-6 shadow-menu outline-none max-[700px]:p-4"
      >
        <div className="flex items-start justify-between gap-4">
          <p className="text-[12.5px] text-text-tertiary">
            {t('Marketplace')} <span className="px-1">›</span> {entry.category}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close')}
            className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <h2 className="mt-4 text-[42px] font-medium leading-[1.08] tracking-[-0.02em] text-text-primary max-[700px]:text-[32px]">
          {entry.name}
        </h2>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span
            className="rounded-[8px] border px-[9px] py-[3px] text-[11.5px] font-semibold"
            style={{ background: color.bg, color: color.fg, borderColor: color.border }}
          >
            {entry.category}
          </span>
          {typeof entry.installCount === 'number' && entry.installCount > 0 && (
            <span className="text-[12.5px] text-text-tertiary">
              {t('{count} adds', { count: formatAdds(entry.installCount) })}
            </span>
          )}
          <span className="text-[12.5px] text-text-tertiary">
            {t('by {author}', { author: marketplaceAuthorLine(entry) })}
          </span>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-b border-border-main pb-2">
          <h3 className="text-sm font-semibold text-text-primary">{t('Instructions')}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <DetailAddAction
              entry={entry}
              installedAgentId={installedAgentId}
              pending={pending}
              onAdd={onAdd}
              onOpenAgent={onOpenAgent}
            />
            <button
              type="button"
              onClick={() => void copyPrompt()}
              className="inline-flex items-center gap-1.5 rounded-[9px] border border-border-main px-3 py-1.5 text-[13px] font-medium text-text-secondary hover:bg-fill-hover"
            >
              <Copy className="size-3.5" aria-hidden /> {copied ? t('Copied') : t('Copy prompt')}
            </button>
          </div>
        </div>
        <pre className="mp-scroll mt-3 max-h-[340px] overflow-auto whitespace-pre-wrap rounded-[14px] border border-border-main bg-fill-tsp p-4 font-mono text-[13.5px] leading-[1.7] text-text-secondary">
          {instructions || t('This bot has no public prompt.')}
        </pre>

        {entry.tools.length > 0 && (
          <section className="mt-7">
            <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">
              {t('Connect first')}
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {entry.tools.map((tool) => (
                <ConnectChip key={tool} tool={tool} url={entry.toolUrls?.[tool]} />
              ))}
            </div>
            <p className="mt-2 text-[12px] text-text-tertiary">
              {t('Unknown or unconnected tools stay listed here. The bot still works.')}
            </p>
          </section>
        )}

        {entry.skills.length > 0 && (
          <section className="mt-7">
            <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">
              {t('Skills')} ({entry.skills.length})
            </h3>
            <div className="mt-2 divide-y divide-border-main">
              {entry.skills.map((skill, index) => (
                <details key={`${skill.name}-${index}`} className="mp-skill py-2">
                  <summary className="cursor-pointer list-none text-[13.5px] font-medium text-text-primary">
                    <span className="mp-skill-chevron me-1.5 inline-block text-text-tertiary" aria-hidden>
                      ›
                    </span>
                    {skill.name}
                  </summary>
                  <p className="mt-1.5 ps-4 text-[13px] text-text-secondary">{skill.description}</p>
                  {skill.content && skill.content !== skill.description && (
                    <pre className="mp-scroll mt-2 ms-4 max-h-[300px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-fill-tsp p-3 font-mono text-[12.5px] leading-[1.6] text-text-tertiary">
                      {skill.content}
                    </pre>
                  )}
                </details>
              ))}
            </div>
          </section>
        )}

        {entry.routines.length > 0 && (
          <section className="mt-7">
            <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">
              {t('Routines')} ({entry.routines.length})
            </h3>
            <ul className="mt-2 space-y-2">
              {entry.routines.map((routine, index) => (
                <li key={`${routine.name}-${index}`}>
                  <p className="text-[13.5px] font-medium text-text-primary">{routine.name}</p>
                  <p className="text-[13px] text-text-tertiary">{routine.summary}</p>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-text-tertiary">
              {t('Routines are created paused. Enable them when you are ready.')}
            </p>
          </section>
        )}

        <section className="mt-7">
          <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">{t('Source')}</h3>
          <div className="mt-3 space-y-2 text-[12.5px] leading-6 text-text-tertiary">
            {entry.source.includes('botdirectory') && (
              <p>
                {t('Prompt contributed by')}{' '}
                {entry.author.name ?? t('a botdirectory contributor')}
                {entry.author.url && (
                  <>
                    {' '}
                    <a href={entry.author.url} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
                      {t('profile')}
                    </a>
                  </>
                )}
                {' · '}
                <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
                  botdirectory.ai
                </a>
                {' · MIT'}
                {entry.author.scoutedBy && <> · {t('scouted by {name}', { name: entry.author.scoutedBy })}</>}
              </p>
            )}
            {entry.source.includes('xai') && (
              <p>
                {t('By {author}', { author: entry.author.name ?? marketplaceAuthorLine(entry) })}
                {' · '}
                <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
                  x.ai {t('listing')}
                  <ExternalLink className="ms-1 inline size-3" aria-hidden />
                </a>
                {entry.addHref && (
                  <>
                    {' · '}
                    <a href={entry.addHref} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
                      {t('Add on x.ai')}
                    </a>
                  </>
                )}
                {' · '}
                {t('all rights reserved')}
              </p>
            )}
            {entry.alsoAt?.map((url) => (
              <p key={url}>
                {t('Also listed at')}{' '}
                <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
                  {url}
                </a>
              </p>
            ))}
            <p className="font-mono text-[11.5px] text-text-tertiary">{entry.license}</p>
          </div>
        </section>

        {related.length > 0 && (
          <section className="mt-7 pb-8">
            <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">
              {t('Related bots')}
            </h3>
            <div className="mt-3 grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
              {related.map((item) => (
                <RelatedBot key={item.id} entry={item} onOpenEntry={onOpenEntry} />
              ))}
            </div>
          </section>
        )}
      </section>
    </div>
  );
}

function DetailAddAction({
  entry,
  installedAgentId,
  pending,
  onAdd,
  onOpenAgent,
}: {
  entry: MarketplaceCatalogEntry;
  installedAgentId?: string;
  pending: boolean;
  onAdd?: (entry: MarketplaceCatalogEntry) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  if (installedAgentId) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-[7px] border border-border-main bg-fill-tsp px-3 py-1.5 text-[13px] font-medium text-text-tertiary">
          <Check className="size-3" aria-hidden />
          {t('Added')}
        </span>
        {onOpenAgent && (
          <button
            type="button"
            onClick={() => onOpenAgent(installedAgentId)}
            className="text-[12px] font-semibold text-text-primary underline underline-offset-2 hover:text-text-secondary"
          >
            {t('Open')}
          </button>
        )}
      </div>
    );
  }
  if (!onAdd) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onAdd(entry);
      }}
      disabled={pending}
      aria-label={t('Add {name}', { name: entry.name })}
      className="inline-flex items-center gap-1.5 rounded-[9px] border border-text-primary bg-text-primary px-3 py-1.5 text-[13px] font-semibold text-text-onblack transition-colors hover:border-text-secondary hover:bg-text-secondary disabled:cursor-wait disabled:opacity-70"
    >
      {pending && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {pending ? t('Adding…') : t('Add')}
    </button>
  );
}

function ConnectChip({ tool, url }: { tool: string; url?: string }) {
  const label = marketplaceToolLabel(tool);
  const content = (
    <>
      <span
        aria-hidden
        className="flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-border-main bg-fill-tsp text-[9px] font-bold text-text-tertiary"
      >
        {label.slice(0, 1)}
      </span>
      {label}
    </>
  );
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 rounded-[7px] border border-border-main bg-bg-main px-2.5 py-1 text-[12.5px] font-medium text-text-secondary hover:bg-fill-hover"
      >
        {content}
      </a>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[7px] border border-border-main bg-bg-main px-2.5 py-1 text-[12.5px] font-medium text-text-secondary">
      {content}
    </span>
  );
}

function RelatedBot({
  entry,
  onOpenEntry,
}: {
  entry: MarketplaceCatalogEntry;
  onOpenEntry?: (entry: MarketplaceCatalogEntry) => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        <MarketplaceBotAvatar entry={entry} size={22} />
        <span className="truncate text-[13px] font-medium text-text-primary">{entry.name}</span>
      </div>
      <span className="line-clamp-2 text-[11.5px] text-text-tertiary">{entry.description}</span>
    </>
  );
  if (!onOpenEntry) {
    return (
      <div className="flex flex-col gap-2 rounded-[14px] border border-border-main bg-bg-main p-3 text-start">{body}</div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenEntry(entry)}
      className="flex flex-col gap-2 rounded-[14px] border border-border-main bg-bg-main p-3 text-start hover:bg-fill-hover"
    >
      {body}
    </button>
  );
}

function MarketplaceBotAvatar({ entry, size }: { entry: MarketplaceCatalogEntry; size: number }) {
  const color = marketplaceCategoryColor(entry.iconStyle?.categoryColor ?? entry.category);
  const shape = entry.iconStyle?.shape;
  const radius = shape === 'circle' || shape === 'dome' ? '50%' : shape === 'squircle' ? 8 : 10;
  if (entry.icon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/marketplace/${entry.icon}`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="shrink-0 border border-border-main object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  const monogram = (entry.iconStyle?.monogram || entry.name.trim()[0] || '?').toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center border text-[12px] font-semibold"
      style={{ width: size, height: size, borderRadius: radius, background: color.bg, color: color.fg, borderColor: color.border }}
    >
      {monogram}
    </span>
  );
}