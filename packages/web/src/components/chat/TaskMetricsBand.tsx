'use client';

import { useEffect, useState } from 'react';
import { t, getLocale } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

interface TaskMetrics {
  turns: number | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  elapsedMs: number | null;
  toolCalls: number;
  filesTouched: number;
  newFiles: number;
  linesAdded: number;
  linesRemoved: number;
  reuseRatio: number | null;
  lastCheck: 'pass' | 'fail' | null;
}

const METRICS_LABEL: Record<string, { en: string; ar: string }> = {
  tokens: { en: 'Tokens', ar: 'الرموز' },
  time: { en: 'Time', ar: 'الزمن' },
  turns: { en: 'Turns', ar: 'الدورات' },
  files: { en: 'Files', ar: 'الملفات' },
  lines: { en: 'Lines', ar: 'الأسطر' },
  reuse: { en: 'Reuse', ar: 'إعادة الاستخدام' },
  check: { en: 'Last check', ar: 'آخر فحص' },
};

/** lazy-senior P4: one compact metrics line for the finished task, fed by
 *  GET /api/tasks/:id/metrics (local data only). Text only — no icons. */
export function TaskMetricsBand({ taskId }: { taskId?: string | null }) {
  const [metrics, setMetrics] = useState<TaskMetrics | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/metrics`, {
          headers: await getApiHeaders(),
        });
        if (!response.ok) return;
        const body = (await response.json()) as TaskMetrics;
        if (!cancelled) setMetrics(body);
      } catch {
        /* the band stays hidden when metrics are unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!taskId || !metrics) return null;
  const rows: Array<{ label: string; value: string }> = [];
  if (metrics.tokensIn !== null || metrics.tokensOut !== null) {
    rows.push({ label: 'tokens', value: `${metrics.tokensIn ?? '?'} / ${metrics.tokensOut ?? '?'}` });
  }
  if (metrics.elapsedMs !== null) rows.push({ label: 'time', value: `${Math.round(metrics.elapsedMs / 1000)}s` });
  if (metrics.turns !== null) rows.push({ label: 'turns', value: String(metrics.turns) });
  if (metrics.filesTouched > 0) {
    rows.push({ label: 'files', value: String(metrics.filesTouched) });
    rows.push({ label: 'lines', value: `+${metrics.linesAdded}/-${metrics.linesRemoved}` });
    if (metrics.reuseRatio !== null) rows.push({ label: 'reuse', value: `${Math.round(metrics.reuseRatio * 100)}%` });
  }
  if (metrics.lastCheck !== null) rows.push({ label: 'check', value: metrics.lastCheck });
  if (rows.length === 0) return null;
  const ar = getLocale() === 'ar';
  return (
    <div
      data-testid="task-metrics-band"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-border-main bg-fill-tsp px-3 py-1.5 text-xs text-text-secondary"
    >
      {rows.map((row) => (
        <span key={row.label} className="whitespace-nowrap">
          <span className="text-text-tertiary">{ar ? METRICS_LABEL[row.label]?.ar : METRICS_LABEL[row.label]?.en}: </span>
          {row.value}
        </span>
      ))}
    </div>
  );
}
