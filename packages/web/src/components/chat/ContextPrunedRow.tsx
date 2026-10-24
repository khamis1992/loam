import type { ContextPrunedEvent } from '@shared/socket';
import { t } from '@/i18n/t';

/**
 * Context-pruning row. Shows how much of the transcript was trimmed verbatim
 * before any summary. Muted like the other diagnostic rows: pruned results
 * stay recallable by the model, so there is nothing for the user to do.
 */
export function ContextPrunedRow({ e }: { e: ContextPrunedEvent }) {
  const omitted = e.truncated + e.dropped;
  return (
    <div className="flex items-center gap-1.5 text-sm text-text-tertiary" data-testid="context-pruned">
      <span className="text-icon-blue">▣</span>
      <span>
        {t('Context trimmed')} · {t('{count} results omitted', { count: omitted })} · {t('{before} to {after} tokens', { before: e.tokensBefore, after: e.tokensAfter })}
      </span>
    </div>
  );
}
