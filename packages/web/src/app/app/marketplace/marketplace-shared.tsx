'use client';

import { Check, Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';

export type Source = 'xai' | 'botdirectory';

export interface CatalogEntry {
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

export interface Install {
  catalogId: string;
  agentId: string;
  addedAt: string;
  catalogVersion: string;
}

/** Spec 3.1: table grid columns. */
export const TABLE_COLUMNS = 'minmax(200px,1.4fr) 130px minmax(160px,1.4fr) 120px 72px';

export const CATEGORY_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  Productivity: { bg: '#EFF6FF', fg: '#006EFF', border: '#D6E8FC' },
  Sales: { bg: '#F3FFEF', fg: '#17A34A', border: '#DDF4D3' },
  Marketing: { bg: '#FFF5EF', fg: '#E65707', border: '#FCE2D5' },
  Operations: { bg: '#EFF3FF', fg: '#124DFF', border: '#D5DEFC' },
  Ops: { bg: '#EFF3FF', fg: '#124DFF', border: '#D5DEFC' },
  'Customer Success': { bg: '#FFEEF8', fg: '#C942B2', border: '#FDD3EB' },
  Success: { bg: '#FFEEF8', fg: '#C942B2', border: '#FDD3EB' },
  Personal: { bg: '#FFFBEF', fg: '#D8A40C', border: '#E7E0CB' },
};

export const FALLBACK_COLOR = { bg: '#F3EAFE', fg: '#6410FF', border: '#E1D5FC' };

export function categoryColor(category: string) {
  return CATEGORY_COLORS[category] ?? FALLBACK_COLOR;
}

export function pluralAdds(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(count);
}

export function toolLabel(tool: string): string {
  const clean = tool.trim();
  if (!clean) return clean;
  return /^[a-z]/.test(clean) ? clean[0]!.toUpperCase() + clean.slice(1) : clean;
}

export function authorLine(entry: CatalogEntry): string {
  if (entry.author.handle) return `@${entry.author.handle}`;
  if (entry.author.name) return entry.author.name;
  return t('Unknown author');
}

export function sourceLabel(entry: CatalogEntry): string {
  if (entry.source.includes('xai')) return authorLine(entry);
  if (entry.source.includes('botdirectory')) return entry.author.name ? `@${entry.author.name}` : t('Contributor');
  return '—';
}

/** x.ai entries publish no prompt, so the detail and copy view compose one. */
export function composedInstructions(entry: CatalogEntry): string {
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

export function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && Array.isArray(v.source);
}

export interface BotActionProps {
  entry: CatalogEntry;
  installedAgentId?: string;
  pending: boolean;
  onAdd: () => void;
  onOpenAgent: () => void;
}

export function AddAction({ entry, installedAgentId, pending, onAdd, onOpenAgent, compact }: BotActionProps & { compact?: boolean }) {
  if (installedAgentId) {
    return (
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-[7px] border border-dark bg-fill-tsp font-medium text-text-tertiary ${
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

export function BotAvatar({ entry, size }: { entry: CatalogEntry; size: number }) {
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
