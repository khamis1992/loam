/**
 * Shared marketplace catalog types and helpers (MARKETPLACE_SPEC §2).
 *
 * The bundled catalog lives at `packages/web/public/marketplace/catalog.json`
 * and is served at MARKETPLACE_CATALOG_URL. These types are structurally
 * identical to the `CatalogEntry` interface used by the marketplace list page
 * (`app/app/marketplace/MarketplacePageClient.tsx`), so the page can adopt
 * them without call-site changes.
 */

import { t } from '@/i18n/t';

/** Web path of the bundled catalog (public/marketplace/catalog.json). */
export const MARKETPLACE_CATALOG_URL = '/marketplace/catalog.json';

export type MarketplaceSource = 'xai' | 'botdirectory';

export interface MarketplaceCatalogEntry {
  id: string; // 'xai-<slug>' | 'bd-<file-slug>'
  source: MarketplaceSource[]; // both when merged by normalized name
  name: string;
  description: string;
  category: string;
  tags: string[];
  icon: string; // local path 'icons/xai/<id>.jpg' or '' (render monogram)
  iconStyle: { color?: string; shape?: string; monogram?: string; categoryColor?: string };
  instructions: string; // bd: full prompt body; xai: '' (not public)
  tools: string[]; // integration display names (Notion, Gmail, ...)
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

/** Loam-side persisted install state (MARKETPLACE_SPEC §2). */
export interface MarketplaceInstall {
  catalogId: string;
  agentId: string;
  addedAt: string;
  catalogVersion: string;
}

/** Runtime guard for entries loaded from the bundled catalog. */
export function isMarketplaceCatalogEntry(value: unknown): value is MarketplaceCatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.category === 'string' &&
    typeof v.sourceUrl === 'string' &&
    typeof v.license === 'string' &&
    Array.isArray(v.source) &&
    Array.isArray(v.tools) &&
    Array.isArray(v.skills) &&
    Array.isArray(v.memories) &&
    Array.isArray(v.routines) &&
    (v.iconStyle === undefined || v.iconStyle === null || typeof v.iconStyle === 'object')
  );
}

/** Category colours (bg -50 / ink / border -150) from MARKETPLACE_SPEC §3.3. */
const MARKETPLACE_CATEGORY_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  Productivity: { bg: '#EFF6FF', fg: '#006EFF', border: '#D6E8FC' },
  Sales: { bg: '#F3FFEF', fg: '#17A34A', border: '#DDF4D3' },
  Marketing: { bg: '#FFF5EF', fg: '#E65707', border: '#FCE2D5' },
  Operations: { bg: '#EFF3FF', fg: '#124DFF', border: '#D5DEFC' },
  Ops: { bg: '#EFF3FF', fg: '#124DFF', border: '#D5DEFC' },
  'Customer Success': { bg: '#FFEEF8', fg: '#C942B2', border: '#FDD3EB' },
  Success: { bg: '#FFEEF8', fg: '#C942B2', border: '#FDD3EB' },
  Personal: { bg: '#FFFBEF', fg: '#D8A40C', border: '#E7E0CB' },
};

/** Unmapped categories (Design, Engineering, Product, …) get purple. */
const MARKETPLACE_FALLBACK_COLOR = { bg: '#F3EAFE', fg: '#6410FF', border: '#E1D5FC' };

export function marketplaceCategoryColor(category: string): { bg: string; fg: string; border: string } {
  return MARKETPLACE_CATEGORY_COLORS[category] ?? MARKETPLACE_FALLBACK_COLOR;
}

/** 1200 → '1.2k', 12500 → '13k', 940 → '940'. */
export function formatAdds(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(count);
}

/** Capitalize the first letter of an integration display name. */
export function marketplaceToolLabel(tool: string): string {
  const clean = tool.trim();
  if (!clean) return clean;
  return /^[a-z]/.test(clean) ? clean[0]!.toUpperCase() + clean.slice(1) : clean;
}

/** '@handle' when known, else the author name, else a muted placeholder. */
export function marketplaceAuthorLine(entry: MarketplaceCatalogEntry): string {
  const author = entry.author as { name?: string; handle?: string } | undefined;
  if (author?.handle) return `@${author.handle}`;
  if (author?.name) return author.name;
  return t('Unknown author');
}

/**
 * x.ai entries publish no prompt, so the detail and copy view compose one from
 * description + skills + memories (MARKETPLACE_SPEC §1 gaps, §4 Add flow).
 */
export function composedInstructions(entry: MarketplaceCatalogEntry): string {
  const direct = (entry.instructions ?? '').trim();
  if (direct) return direct;
  const parts: string[] = [];
  if ((entry.description ?? '').trim()) parts.push(entry.description.trim());
  if (entry.skills.length > 0) {
    parts.push('## Skills');
    for (const skill of entry.skills) {
      const lines = [
        skill.name ? `### ${skill.name}` : '',
        skill.description,
        skill.content && skill.content !== skill.description ? skill.content : '',
      ].filter(Boolean);
      if (lines.length > 0) parts.push(lines.join('\n\n'));
    }
  }
  if (entry.memories.length > 0) {
    parts.push('## Memory');
    parts.push(entry.memories.map((memory) => `- ${memory.trim()}`).join('\n'));
  }
  return parts.join('\n\n');
}