'use client';

import { t } from '@/i18n/t';

/** One citation's state, shown inline next to the formal reference. Never colour-only: every state has a text label. */
export type BadgeState = 'verified' | 'normalized' | 'historical' | 'amended' | 'failed' | 'unverified';

const STYLES: Record<BadgeState, { cls: string; label: string }> = {
  verified: { cls: 'border-emerald-600/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200', label: 'Verified' },
  normalized: { cls: 'border-teal-600/40 bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200', label: 'Verified (spelling normalized)' },
  historical: { cls: 'border-amber-600/40 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200', label: 'Historical text' },
  amended: { cls: 'border-amber-600/40 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200', label: 'Amended later' },
  failed: { cls: 'border-red-600/50 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200', label: 'Not verified' },
  unverified: { cls: 'border-zinc-500/50 bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200', label: 'Needs lawyer research' },
};

export function badgeStateFor(status: string, warnings: string[] = []): BadgeState {
  if (status === 'VERIFIED' || status === 'OK') {
    if (warnings.includes('HISTORICAL_CITATION')) return 'historical';
    if (warnings.includes('AMENDED_AFTER_DATE')) return 'amended';
    if (warnings.includes('ORTHOGRAPHIC_MATCH')) return 'normalized';
    return 'verified';
  }
  if (status === 'VERIFIED_NORMALIZED') return 'normalized';
  return 'failed';
}

export function CitationBadge({ state, reference, title }: { state: BadgeState; reference?: string; title?: string }) {
  const s = STYLES[state];
  return (
    <span
      dir="auto"
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium ${s.cls}`}
    >
      <span aria-hidden="true">{state === 'failed' ? '✕' : state === 'unverified' ? '?' : state === 'verified' || state === 'normalized' ? '✓' : '!'}</span>
      <span>{t(s.label)}</span>
      {reference ? <bdi className="font-normal opacity-80">{reference}</bdi> : null}
    </span>
  );
}
