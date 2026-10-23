import type { CacheUsageEvent } from '@shared/socket';
import { t } from '@/i18n/t';

/**
 * Prompt-cache (KV) accounting row. Shows the reusable-token counters for the
 * last provider request and, when the provider reported a real miss, the
 * classified reason. Muted like the other diagnostic rows: it is never an
 * action the user can take.
 */
export function CacheUsageRow({ e }: { e: CacheUsageEvent }) {
  const ratio = e.promptTokens > 0 ? Math.round((e.cachedTokens / e.promptTokens) * 100) : 0;
  return (
    <div className="flex flex-col gap-0.5 text-sm text-text-tertiary" data-testid="cache-usage">
      <div className="flex items-center gap-1.5">
        <span className="text-icon-blue">▣</span>
        <span>
          {t('Prompt cache')} · {e.provider} · {e.model} · {t('{count} tokens reused', { count: e.cachedTokens })} ({ratio}%)
        </span>
      </div>
      {e.miss && (
        <div className="ps-4 text-text-tertiary" data-testid="cache-usage-miss">
          {e.miss.message}
        </div>
      )}
    </div>
  );
}
