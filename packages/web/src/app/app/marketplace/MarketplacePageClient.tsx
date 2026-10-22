'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  Copy,
  LayoutGrid,
  List,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import {
  AddAction,
  BotAvatar,
  CatalogEntry,
  Install,
  authorLine,
  categoryColor,
  composedInstructions,
  isCatalogEntry,
  pluralAdds,
  toolLabel,
} from './marketplace-shared';
import { MarketplaceBotTable } from './MarketplaceBotTable';
import { MarketplaceBotCard } from './MarketplaceBotCard';
import { EntryAttribution } from './EntryAttribution';

type Toast = { kind: 'success' | 'error'; text: string; agentId?: string } | null;

export default function MarketplacePageClient() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installs, setInstalls] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<Toast>(null);
  const [view, setView] = useState<'table' | 'cards'>('table');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [integration, setIntegration] = useState('');
  const [sort, setSort] = useState<'most-added' | 'az' | 'recent' | 'category'>('most-added');
  const [detail, setDetail] = useState<CatalogEntry | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('loam.marketplace.view');
      if (stored === 'cards' || stored === 'table') setView(stored);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/marketplace/catalog.json');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: unknown = await res.json();
        if (!Array.isArray(data)) throw new Error('catalog is not an array');
        if (!cancelled) setCatalog(data.filter(isCatalogEntry));
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadInstalls = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/marketplace/installs`, { headers: await getApiHeaders() });
      if (!res.ok) return;
      const data = (await res.json()) as { installs?: Install[] };
      const next: Record<string, string> = {};
      for (const install of data.installs ?? []) {
        if (install.catalogId && install.agentId) next[install.catalogId] = install.agentId;
      }
      setInstalls(next);
    } catch {
      /* installs are best-effort */
    }
  }, []);

  useEffect(() => {
    void loadInstalls();
  }, [loadInstalls]);

  // Archiving clears Added on the server; refresh when the tab regains focus.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void loadInstalls();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadInstalls]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 5000 : 7000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetail(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  const categories = useMemo(
    () => Array.from(new Set(catalog.map((entry) => entry.category))).sort((a, b) => a.localeCompare(b)),
    [catalog],
  );

  const integrations = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const entry of catalog) {
      for (const tool of entry.tools) {
        const key = tool.trim().toLowerCase();
        if (key && !byKey.has(key)) byKey.set(key, tool.trim());
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
  }, [catalog]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const integrationKey = integration.trim().toLowerCase();
    const filtered = catalog.filter((entry) => {
      if (category && entry.category !== category) return false;
      if (integrationKey && !entry.tools.some((tool) => tool.trim().toLowerCase() === integrationKey)) return false;
      if (!query) return true;
      const haystack = [
        entry.name,
        entry.description,
        entry.category,
        ...entry.tags,
        ...entry.tools,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === 'az') return a.name.localeCompare(b.name);
      if (sort === 'category') return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
      if (sort === 'recent') {
        const at = Date.parse(a.updatedAt ?? a.addedAt ?? '') || 0;
        const bt = Date.parse(b.updatedAt ?? b.addedAt ?? '') || 0;
        return bt - at || a.name.localeCompare(b.name);
      }
      return (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name);
    });
    return sorted;
  }, [catalog, category, integration, search, sort]);

  const addToLoam = async (entry: CatalogEntry) => {
    if (pending[entry.id] || installs[entry.id]) return;
    setPending((prev) => ({ ...prev, [entry.id]: true }));
    try {
      const res = await fetch(`${getApiBase()}/api/agents/from-catalog`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ catalogId: entry.id }),
      });
      const data = (await res.json()) as { agent?: { id?: string }; error?: string };
      if (!res.ok || !data.agent?.id) throw new Error(data.error ?? `status ${res.status}`);
      const agentId = data.agent.id;
      setInstalls((prev) => ({ ...prev, [entry.id]: agentId }));
      setToast({ kind: 'success', text: t('{name} added to Agent Loam', { name: entry.name }), agentId });
    } catch {
      setToast({ kind: 'error', text: t("Couldn't add {name}", { name: entry.name }) });
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
    }
  };

  const openAgent = (agentId: string) => {
    router.push(`/app/agents?agent=${encodeURIComponent(agentId)}`);
  };

  const setViewMode = (next: 'table' | 'cards') => {
    setView(next);
    try {
      localStorage.setItem('loam.marketplace.view', next);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1150px] px-6 py-8">
      <header>
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#2563EB]">{t('Works with Loam')}</p>
        <h1 className="mt-2 text-[46px] font-medium leading-[1.05] tracking-[-0.02em] text-text-primary max-[700px]:text-[34px]">
          {t('The Loam bot directory')}
        </h1>
        <p className="mt-3 text-[18px] text-text-tertiary">
          {t('Bots that get stuff done. Add one with a single click.')}
        </p>
      </header>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-b border-border-main pb-3.5">
        <div className="flex flex-wrap items-center gap-3.5">
          <div className="flex items-center gap-2 border-b border-border-main pb-1">
            <Search className="size-3.5 text-text-tertiary" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('Search bots')}
              aria-label={t('Search bots')}
              className="w-[150px] bg-transparent text-[13.5px] text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>

          <FilterSelect
            label={t('Any category')}
            value={category}
            onChange={setCategory}
            swatch={category ? categoryColor(category).bg : undefined}
          >
            <option value="">{t('Any category')}</option>
            {categories.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </FilterSelect>

          <FilterSelect label={t('Any integration')} value={integration} onChange={setIntegration}>
            <option value="">{t('Any integration')}</option>
            {integrations.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </FilterSelect>

          <FilterSelect label={t('Most added')} value={sort} onChange={(value) => setSort(value as typeof sort)}>
            <option value="most-added">{t('Most added')}</option>
            <option value="az">A–Z</option>
            <option value="recent">{t('Recently added')}</option>
            <option value="category">{t('Category')}</option>
          </FilterSelect>
        </div>

        <div className="flex items-center gap-2 border-s border-border-main ps-2">
          <ViewButton active={view === 'table'} onClick={() => setViewMode('table')} icon={<List className="size-3.5" />}>
            {t('Table')}
          </ViewButton>
          <ViewButton active={view === 'cards'} onClick={() => setViewMode('cards')} icon={<LayoutGrid className="size-3.5" />}>
            {t('Cards')}
          </ViewButton>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-24 text-text-secondary">
          <Loader2 className="size-5 animate-spin" /> {t('Loading')}
        </div>
      ) : loadError ? (
        <div className="rounded-[20px] border border-border-main bg-bg-menu p-10 text-center text-sm text-func-error">
          {t('Could not load the marketplace catalog.')}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-[20px] border border-dashed border-dark px-6 py-[72px] text-center">
          <h2 className="text-base text-text-primary">{t('No bot for that yet.')}</h2>
          <p className="mt-2 text-sm text-text-tertiary">{t('Try another search or category.')}</p>
        </div>
      ) : (
        <>
          <div className={`mt-6 ${view === 'table' ? 'hidden min-[901px]:block' : 'hidden'}`}>
            <MarketplaceBotTable
              entries={visible}
              installs={installs}
              pending={pending}
              onOpenDetail={setDetail}
              onAdd={(entry) => void addToLoam(entry)}
              onOpenAgent={openAgent}
            />
          </div>

          <div
            className={`mt-6 grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-[18px] max-[900px]:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] ${
              view === 'cards' ? '' : 'min-[901px]:hidden'
            }`}
          >
            {visible.map((entry) => (
              <MarketplaceBotCard
                key={entry.id}
                entry={entry}
                installedAgentId={installs[entry.id]}
                pending={Boolean(pending[entry.id])}
                onOpenDetail={() => setDetail(entry)}
                onAdd={() => void addToLoam(entry)}
                onOpenAgent={() => {
                  const agentId = installs[entry.id];
                  if (agentId) openAgent(agentId);
                }}
              />
            ))}
          </div>
        </>
      )}

      <footer className="mt-10 border-t border-border-main pt-4 text-xs leading-6 text-text-tertiary">
        <p>
          {t(
            'Bot listings from botdirectory.ai are MIT licensed (Copyright (c) 2026 Inbox Zero Inc.); each prompt stays credited to its contributor.',
          )}{' '}
          <a className="underline hover:text-text-secondary" href="/marketplace/THIRD_PARTY_NOTICES" target="_blank" rel="noreferrer">
            {t('Third-party notices')}
          </a>
        </p>
        <p>
          {t(
            'x.ai marketplace entries link back to their original listing and are all rights reserved; Loam never rehosts their prompts.',
          )}
        </p>
      </footer>

      {detail && (
        <MarketplaceDetail
          entry={detail}
          catalog={catalog}
          installedAgentId={installs[detail.id]}
          pending={Boolean(pending[detail.id])}
          onClose={() => setDetail(null)}
          onAdd={() => void addToLoam(detail)}
          onOpenAgent={() => {
            const agentId = installs[detail.id];
            if (agentId) openAgent(agentId);
          }}
          onOpenEntry={(entry) => setDetail(entry)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-[10px] bg-text-primary px-4 py-2.5 text-[13px] text-text-onblack shadow-menu">
          <span>{toast.text}</span>
          {toast.agentId && (
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => {
                const agentId = toast.agentId;
                setToast(null);
                if (agentId) openAgent(agentId);
              }}
            >
              {t('Open')}
            </button>
          )}
          <button type="button" aria-label={t('Dismiss')} onClick={() => setToast(null)} className="opacity-70 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  swatch,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Spec 3.1: category selects show a 9x9 r3 colour swatch. */
  swatch?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="relative inline-flex items-center gap-1.5 text-[13.5px] text-text-secondary">
      <span className="sr-only">{label}</span>
      {swatch && <span className="size-[9px] shrink-0 rounded-[3px]" style={{ background: swatch }} aria-hidden />}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="appearance-none bg-transparent py-1 pe-5 text-[13.5px] text-text-secondary outline-none"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute end-0 size-3.5 text-text-tertiary" aria-hidden />
    </label>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-0.5 py-1 text-[13.5px] font-medium ${
        active ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function MarketplaceDetail({
  entry,
  catalog,
  installedAgentId,
  pending,
  onClose,
  onAdd,
  onOpenAgent,
  onOpenEntry,
}: {
  entry: CatalogEntry;
  catalog: CatalogEntry[];
  installedAgentId?: string;
  pending: boolean;
  onClose: () => void;
  onAdd: () => void;
  onOpenAgent: () => void;
  onOpenEntry: (entry: CatalogEntry) => void;
}) {
  const [copied, setCopied] = useState(false);
  const color = categoryColor(entry.category);
  const instructions = composedInstructions(entry);
  const related = catalog.filter((item) => item.id !== entry.id && item.category === entry.category).slice(0, 3);
  const relatedBuilder = catalog.filter((item) => item.id !== entry.id && item.category !== entry.category).slice(0, 3);
  const suggestions = related.length > 0 ? related : relatedBuilder;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(instructions);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <button type="button" aria-label={t('Close')} onClick={onClose} className="flex-1 bg-black/30" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={entry.name}
        className="flex h-full w-full max-w-[720px] flex-col overflow-y-auto border-s border-border-main bg-bg-menu p-6 shadow-menu"
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
            <X className="size-4" />
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
            <span className="text-[12.5px] text-text-tertiary">{t('{count} adds', { count: pluralAdds(entry.installCount) })}</span>
          )}
          <span className="text-[12.5px] text-text-tertiary">
            {t('by {author}', { author: authorLine(entry) })}
          </span>
        </div>

        <div className="mt-8 flex items-center justify-between gap-3 border-b border-border-main pb-2">
          <h3 className="text-sm font-semibold text-text-primary">{t('Instructions')}</h3>
          <div className="flex items-center gap-2">
            <AddAction
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
              <Copy className="size-3.5" /> {copied ? t('Copied') : t('Copy prompt')}
            </button>
          </div>
        </div>
        <pre className="mt-3 max-h-[340px] overflow-auto whitespace-pre-wrap rounded-[14px] border border-border-main bg-fill-tsp p-4 font-mono text-[13.5px] leading-[1.7] text-text-secondary">
          {instructions || t('This bot has no public prompt.')}
        </pre>

        {entry.tools.length > 0 && (
          <section className="mt-7">
            <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">{t('Connect first')}</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {entry.tools.map((tool) => (
                <span
                  key={tool}
                  className="inline-flex items-center gap-1.5 rounded-[7px] border border-border-main bg-bg-main px-2.5 py-1 text-[12.5px] font-medium text-text-secondary"
                >
                  <span className="size-[18px] rounded-[4px] border border-border-main bg-fill-tsp" aria-hidden />
                  {toolLabel(tool)}
                </span>
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
                <details key={`${skill.name}-${index}`} className="group py-2">
                  <summary className="cursor-pointer list-none text-[13.5px] font-medium text-text-primary">
                    <span className="me-1.5 inline-block text-text-tertiary transition-transform group-open:rotate-90">›</span>
                    {skill.name}
                  </summary>
                  <p className="mt-1.5 ps-4 text-[13px] text-text-secondary">{skill.description}</p>
                  {skill.content && skill.content !== skill.description && (
                    <pre className="mt-2 ms-4 whitespace-pre-wrap rounded-[10px] bg-fill-tsp p-3 font-mono text-[12.5px] leading-[1.6] text-text-tertiary">
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
            <p className="mt-2 text-[12px] text-text-tertiary">{t('Routines are created paused. Enable them when you are ready.')}</p>
          </section>
        )}

        <EntryAttribution entry={entry} />

        {suggestions.length > 0 && (
          <section className="mt-7 pb-8">
            <h3 className="border-b border-border-main pb-2 text-sm font-semibold text-text-primary">{t('Related bots')}</h3>
            <div className="mt-3 grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
              {suggestions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpenEntry(item)}
                  className="flex flex-col gap-2 rounded-[14px] border border-border-main bg-bg-main p-3 text-start hover:bg-fill-hover"
                >
                  <div className="flex items-center gap-2">
                    <BotAvatar entry={item} size={22} />
                    <span className="truncate text-[13px] font-medium text-text-primary">{item.name}</span>
                  </div>
                  <span className="line-clamp-2 text-[11.5px] text-text-tertiary">{item.description}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </section>
    </div>
  );
}
