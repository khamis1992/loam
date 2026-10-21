'use client';

import { t } from '../../i18n/t';

/**
 * Subtle provenance badge for agents imported from a Grok Bot bundle
 * (agent.source === 'grokbot').
 */
export function GrokBotBadge() {
  return (
    <span
      title={t('Imported from Grok Bot')}
      className="inline-flex shrink-0 items-center rounded-full border border-border-main bg-fill-tsp px-1.5 py-0.5 text-[10px] leading-none text-text-tertiary"
    >
      {t('Grok Bot')}
    </span>
  );
}

export function isGrokBotAgent(source?: string): boolean {
  return source === 'grokbot';
}
