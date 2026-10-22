'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Lightbulb, Loader2, Wrench } from 'lucide-react';
import { fetchSessionInsights, type SessionInsights } from '@/services/insightsApi';
import { Spinner } from '@/components/ui/Button';

interface SessionInsightsPanelProps {
  taskId: string;
  onClose?: () => void;
}

const ISSUE_LABEL: Record<string, string> = {
  error: 'Error',
  failure: 'Failed tool',
  retry: 'Retry',
  stall: 'Stall',
};

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border-main bg-bg-menu p-3">
      <div className="text-xs text-text-tertiary">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text-primary">{value}</div>
    </div>
  );
}

/**
 * Session insights (D18): the post-mortem panel for one task — exact metrics,
 * the issue timeline, knowledge usage, actionable feedback and an improved
 * prompt. Data comes from GET /api/tasks/:id/insights.
 */
export function SessionInsightsPanel({ taskId, onClose }: SessionInsightsPanelProps) {
  const [insights, setInsights] = useState<SessionInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchSessionInsights(taskId)
      .then((res) => { if (alive) setInsights(res.insights); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [taskId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-text-tertiary" data-testid="insights-loading">
        <Spinner className="h-4 w-4" />
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading session insights…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-func-error" data-testid="insights-error">
        <AlertCircle className="h-4 w-4" />
        <span>Could not load session insights: {error}</span>
      </div>
    );
  }

  if (!insights) return null;

  const { metrics, issueTimeline, knowledgeUsage, actionableFeedback, improvedPrompt } = insights;

  return (
    <section className="space-y-4 p-4" data-testid="session-insights-panel" aria-label="Session insights">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Session insights</h2>
        {onClose ? (
          <button type="button" onClick={onClose} className="text-sm text-text-tertiary hover:text-text-primary" aria-label="Close insights">
            Close
          </button>
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Steps" value={metrics.steps} />
        <Metric label="Tool calls" value={`${metrics.toolCalls} (${metrics.toolFailures} failed)`} />
        <Metric label="Tokens" value={`${metrics.totalTokens} ($${metrics.costUsd.toFixed(4)})`} />
        <Metric label="Duration" value={formatDuration(metrics.durationMs)} />
        <Metric label="User messages" value={metrics.userMessages} />
        <Metric label="Assistant messages" value={metrics.assistantMessages} />
        <Metric label="Category" value={metrics.category} />
        <Metric label="Model" value={metrics.model} />
      </div>

      <div className="rounded-lg border border-border-main bg-bg-menu p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
          <Wrench className="h-4 w-4" />
          Knowledge &amp; memory usage
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm text-text-tertiary sm:grid-cols-4">
          <span>Memories: {knowledgeUsage.memories}</span>
          <span>Skills: {knowledgeUsage.skills}</span>
          <span>Memory calls: {knowledgeUsage.memoryToolCalls}</span>
          <span>Skill calls: {knowledgeUsage.skillToolCalls}</span>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">Issue timeline</h3>
        {issueTimeline.length === 0 ? (
          <p className="text-sm text-text-tertiary" data-testid="insights-no-issues">No issues recorded for this session.</p>
        ) : (
          <ol className="space-y-1" data-testid="insights-timeline">
            {issueTimeline.map((issue) => (
              <li key={`${issue.index}-${issue.kind}`} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 rounded bg-bg-menu px-1.5 py-0.5 text-xs text-text-tertiary">{ISSUE_LABEL[issue.kind] ?? issue.kind}</span>
                <span className="text-text-primary">{issue.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">Actionable feedback</h3>
        <ul className="space-y-1" data-testid="insights-feedback">
          {actionableFeedback.map((line, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      {improvedPrompt ? (
        <div>
          <h3 className="mb-2 text-sm font-medium text-text-primary">Improved prompt for next time</h3>
          <pre className="whitespace-pre-wrap rounded-lg border border-border-main bg-bg-menu p-3 text-sm text-text-primary" data-testid="insights-improved-prompt">
            {improvedPrompt}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
