'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
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
import { EntryAttribution } from './EntryAttribution';

type Source = 'xai' | 'botdirectory';

interface CatalogEntry {
  id: string;
  source: Source[];
  name: string;
  description: string;
  category: string;
  tags: string[];
  icon: string;
  iconStyle: { color?: string; shape?: string; monogram?: string; categoryColor?: string };
  instructions: string;
  tools: string[];
  toolUrls?: Record<string, string>;
  skills: Array<{ name: string; description: string; content: string }>;
  memories: string[];
  routines: Array<{ name: string; summary: string }>;
  author: { name?: string; handle?: string; url?: string; scoutedBy?: string };
  installCount?: number;
  addedAt?: string;
  updatedAt?: string;
  addHref?: string;
  grokShareUrl?: string;
  homepage?: string;
  sourceUrl: string;
  alsoAt?: string[];
  license: string;
}

interface Install {
  catalogId: string;
  agentId: string;
  addedAt: string;
  catalogVersion: string;
}

type Toast = { kind: 'success' | 'error'; text: string; agentId?: string } | null;

const TABLE_COLUMNS = 'minmax(200px,1.4fr) 130px minmax(160px,1.4fr) 120px 72px';

const CATEGORY_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  Productivity: { bg: '#EFF6FF', fg: '#006EFF', border: '#D6E8FC' },
  Sales: { bg: '#F3FFEF', fg: '#17A34A', border: '#DDF4D3' },
  Marketing: { bg: '#FFF5EF', fg: '#E65707', border: '#FCE2D5' },
  Operations: { bg: '#EFF3FF', fg: '#124DFF', border: '#D5DEFC' },
  Ops: { bg: '#EFF3FF', fg: '#124DFF', border: '#D5DEFC' },
  'Customer Success': { bg: '#FFEEF8', fg: '#C942B2', border: '#FDD3EB' },
  Success: { bg: '#FFEEF8', fg: '#C942B2', border: '#FDD3EB' },
  Personal: { bg: '#FFFBEF', fg: '#D8A40C', border: '#E7E0CB' },
};

const FALLBACK_COLOR = { bg: '#F3EAFE', fg: '#6410FF', border: '#E1D5FC' };

function categoryColor(category: string) {
  return CATEGORY_COLORS[category] ?? FALLBACK_COLOR;
}

function pluralAdds(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(count);
}

function toolLabel(tool: string): string {
  const clean = tool.trim();
  if (!clean) return clean;
  return /^[a-z]/.test(clean) ? clean[0]!.toUpperCase() + clean.slice(1) : clean;
}

function authorLine(entry: CatalogEntry): string {
  if (entry.author.handle) return `@${entry.author.handle}`;
  if (entry.author.name) return entry.author.name;
  return t('Unknown author');
}

function sourceLabel(entry: CatalogEntry): string {
  if (entry.source.includes('xai')) return authorLine(entry);
  if (entry.source.includes('botdirectory')) return entry.author.name ? `@${entry.author.name}` : t('Contributor');
  return '—';
}

/** x.ai entries publish no prompt, so the detail and copy view compose one. */
function composedInstructions(entry: CatalogEntry): string {
  const direct = (entry.instructions ?? '').trim();
  if (direct) return direct;
  const parts: string[] = [];
  if (entry.description.trim()) parts.push(entry.description.trim());
  if (entry.skills.length > 0) {
    parts.push('## Skills');
    for (const skill of entry.skills) {
      const lines = [skill.name ? `### ${skill.name}` : '', skill.description, skill.content && skill.content !== skill.description ? skill.content : ''].filter(Boolean);
      if (lines.length > 0) parts.push(lines.join('\n\n'));
    }
  }
  if (entry.memories.length > 0) {
    parts.push('## Memory');
    parts.push(entry.memories.map((memory) => `- ${memory.trim()}`).join('\n'));
  }
  return parts.join('\n\n');
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && Array.isArray(v.source);
}

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

  const addProps = { installs, pending, onAdd: addToLoam, onOpenAgent: openAgent };

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

          <FilterSelect label={t('Any category')} value={category} onChange={setCategory}>
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
        <div className="rounded-[20px] border border-dashed border-border-main px-6 py-16 text-center">
          <h2 className="text-base text-text-primary">{t('No bot for that yet.')}</h2>
          <p className="mt-2 text-sm text-text-tertiary">{t('Try another search or category.')}</p>
        </div>
      ) : (
        <>
          <div
            className={`mt-6 overflow-hidden rounded-[20px] border border-border-main bg-bg-menu shadow-card ${
              view === 'table' ? 'hidden min-[901px]:block' : 'hidden'
            }`}
          >
            <div
              className="grid items-center gap-4 border-b border-border-main bg-fill-tsp px-[18px] py-3 text-[12px] font-semibold text-text-tertiary"
              style={{ gridTemplateColumns: TABLE_COLUMNS }}
            >
              <span>{t('Bot')}</span>
              <span>{t('Category')}</span>
              <span>{t('Integrations')}</span>
              <span>{t('Source')}</span>
              <span className="justify-self-end">{t('Add')}</span>
            </div>
            {visible.map((entry) => (
              <BotRow
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

          <div
            className={`mt-6 grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-[18px] max-[900px]:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] ${
              view === 'cards' ? '' : 'min-[901px]:hidden'
            }`}
          >
            {visible.map((entry) => (
              <BotCard
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
          x.ai marketplace entries link back to their original listing and are all rights reserved; Loam never rehosts their prompts.
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
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="relative inline-flex items-center text-[13.5px] text-text-secondary">
      <span className="sr-only">{label}</span>
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

function AddAction({
  entry,
  installedAgentId,
  pending,
  onAdd,
  onOpenAgent,
  compact,
}: {
  entry: CatalogEntry;
  installedAgentId?: string;
  pending: boolean;
  onAdd: () => void;
  onOpenAgent: () => void;
  compact?: boolean;
}) {
  if (installedAgentId) {
    return (
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-[7px] border border-border-main bg-fill-tsp font-medium text-text-tertiary ${
            compact ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]'
          }`}
        >
          <Check className="size-3" aria-hidden />
          {t('Added')}
        </span>
        <button
          type="button"
          onClick={onOpenAgent}
          className="text-[12px] font-semibold text-text-primary underline underline-offset-2 hover:text-text-secondary"
        >
          {t('Open')}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onAdd();
      }}
      disabled={pending}
      aria-label={t('Add {name}', { name: entry.name })}
      className={`inline-flex items-center gap-1.5 border border-text-primary bg-text-primary font-semibold text-text-onblack transition-colors hover:border-text-secondary hover:bg-text-secondary disabled:cursor-wait disabled:opacity-70 ${
        compact ? 'rounded-[7px] px-2.5 py-1 text-[12px]' : 'rounded-[9px] px-3 py-1.5 text-[13px]'
      }`}
    >
      {pending && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {pending ? t('Adding…') : t('Add')}
    </button>
  );
}

function BotRow({
  entry,
  installedAgentId,
  pending,
  onOpenDetail,
  onAdd,
  onOpenAgent,
}: {
  entry: CatalogEntry;
  installedAgentId?: string;
  pending: boolean;
  onOpenDetail: () => void;
  onAdd: () => void;
  onOpenAgent: () => void;
}) {
  const color = categoryColor(entry.category);
  const tools = entry.tools.slice(0, 3);
  const extra = entry.tools.length - tools.length;

  return (
    <div
      className="relative grid items-center gap-4 border-b border-border-main px-[18px] py-[13px] transition-colors last:border-b-0 hover:bg-fill-hover"
      style={{ gridTemplateColumns: TABLE_COLUMNS }}
    >
      <div className="flex min-w-0 flex-col gap-[3px]">
        <button
          type="button"
          onClick={onOpenDetail}
          className="truncate text-start text-[15.5px] font-medium tracking-[-0.01em] text-text-primary after:absolute after:inset-0 after:z-[1] after:content-['']"
        >
          {entry.name}
        </button>
        <span className="truncate text-[12.5px] text-text-tertiary">{entry.description}</span>
      </div>

      <div>
        <span
          className="inline-block rounded-[8px] border px-[9px] py-[3px] text-[11.5px] font-semibold"
          style={{ background: color.bg, color: color.fg, borderColor: color.border }}
        >
          {entry.category}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-tertiary">
        {tools.length === 0 ? (
          <span className="text-text-tertiary">—</span>
        ) : (
          tools.map((tool) => <span key={tool} className="whitespace-nowrap">{toolLabel(tool)}</span>)
        )}
        {extra > 0 && <span className="text-text-tertiary">+{extra}</span>}
      </div>

      <span className="truncate font-mono text-[12.5px] text-text-secondary">{sourceLabel(entry)}</span>

      <div className="relative z-[2] flex justify-end">
        <AddAction
          entry={entry}
          installedAgentId={installedAgentId}
          pending={pending}
          onAdd={onAdd}
          onOpenAgent={onOpenAgent}
          compact
        />
      </div>
    </div>
  );
}

function BotCard({
  entry,
  installedAgentId,
  pending,
  onOpenDetail,
  onAdd,
  onOpenAgent,
}: {
  entry: CatalogEntry;
  installedAgentId?: string;
  pending: boolean;
  onOpenDetail: () => void;
  onAdd: () => void;
  onOpenAgent: () => void;
}) {
  const color = categoryColor(entry.category);
  const tools = entry.tools.slice(0, 4);

  return (
    <div className="relative flex flex-col gap-3 rounded-[20px] border border-border-main bg-bg-menu p-5 shadow-card transition-all duration-[180ms] hover:-translate-y-0.5 hover:shadow-menu">
      <div className="flex items-start gap-2.5">
        <BotAvatar entry={entry} size={28} />
        <button
          type="button"
          onClick={onOpenDetail}
          className="min-w-0 flex-1 truncate text-start text-[19px] font-medium leading-tight text-text-primary after:absolute after:inset-0 after:z-[1] after:content-['']"
        >
          {entry.name}
        </button>
        <div className="relative z-[2]">
          <AddAction
            entry={entry}
            installedAgentId={installedAgentId}
            pending={pending}
            onAdd={onAdd}
            onOpenAgent={onOpenAgent}
          />
        </div>
      </div>

      <p className="line-clamp-4 min-h-[98px] rounded-[10px] border border-border-main bg-fill-tsp px-3 py-2.5 font-mono text-[12px] leading-[19px] text-text-tertiary">
        {entry.description || composedInstructions(entry)}
      </p>

      <div className="flex flex-wrap gap-1.5">
        {tools.map((tool) => (
          <span key={tool} className="rounded-[7px] border border-border-main bg-bg-menu px-2 py-[3px] text-[12px] font-medium text-text-secondary">
            {toolLabel(tool)}
          </span>
        ))}
        {entry.tools.length > tools.length && (
          <span className="px-1 py-[3px] text-[12px] text-text-tertiary">+{entry.tools.length - tools.length}</span>
        )}
      </div>

      <div className="mt-auto flex items-end justify-between gap-2">
        <span
          className="rounded-[8px] border px-[9px] py-[3px] text-[11.5px] font-semibold"
          style={{ background: color.bg, color: color.fg, borderColor: color.border }}
        >
          {entry.category}
        </span>
        <span className="truncate font-mono text-[12.5px] text-text-tertiary">{sourceLabel(entry)}</span>
      </div>
    </div>
  );
}

function BotAvatar({ entry, size }: { entry: CatalogEntry; size: number }) {
  const color = categoryColor(entry.iconStyle?.categoryColor ?? entry.category);
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
