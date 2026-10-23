import { AlertTriangle } from 'lucide-react';
import { t } from '@/i18n/t';
import type { EnvironmentIssueEvent } from '@shared/socket';

/**
 * D17: environment-issue card.
 *
 * Renders an `environmentIssue` chat event: the agent could not run a step
 * because of a local environment problem. It shows the report and the guidance
 * for continuing (rely on CI, skip the step with an explicit note, or ask the
 * user to fix the environment) instead of trying to repair the environment.
 */
export function EnvironmentIssueCard({ issue }: { issue: EnvironmentIssueEvent }) {
  return (
    <div
      role="group"
      aria-label={t('Environment issue')}
      className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-4 shadow-card"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <AlertTriangle className="size-5 text-func-warning" aria-hidden />
        {t('Environment issue')}
      </div>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-text-primary">{issue.message}</p>
        {issue.details && (
          <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-control border border-border-main bg-fill-tsp-white-light p-3 font-mono text-xs text-text-primary">
            {issue.details}
          </pre>
        )}
        <p className="text-sm text-text-secondary">
          {t('Continue by relying on CI, skipping this step with an explicit note, or asking the user to fix the environment. Do not report the step as passed.')}
        </p>
      </div>
    </div>
  );
}
