'use client';

import { t } from '@/i18n/t';

/** D19 session runtime badge payload, mirroring the server snapshot(). */
export interface SessionRuntimeSnapshot {
  state: string;
  sleeping: boolean;
  budget: {
    steps: number;
    stepLimit?: number;
    tokens: number;
    tokenLimit?: number;
    percent: number;
    warning?: string;
    stopped: boolean;
  };
  msUntilSleep?: number;
  raised: boolean;
}

/** Warns at 80% and stops at 100% (must match src/agent/computeBudget.ts). */
export const BUDGET_WARN_RATIO = 0.8;

export function budgetVerdict(percent: number): 'ok' | 'warn' | 'stop' {
  if (percent >= 100) return 'stop';
  if (percent >= Math.round(BUDGET_WARN_RATIO * 100)) return 'warn';
  return 'ok';
}

export function formatBudget(budget: SessionRuntimeSnapshot['budget']): string {
  const steps = budget.stepLimit !== undefined ? `${budget.steps}/${budget.stepLimit}` : `${budget.steps}`;
  const tokens = budget.tokenLimit !== undefined ? `${budget.tokens}/${budget.tokenLimit}` : `${budget.tokens}`;
  return `steps ${steps} · tokens ${tokens}`;
}

/** The label the badge shows for a session runtime state. */
export function sessionStateLabel(state: string, sleeping: boolean): string {
  if (sleeping || state === 'sleeping') return t('Sleeping');
  switch (state) {
    case 'idle':
      return t('Waiting for user...');
    case 'awake':
      return t('Working');
    case 'active':
      return t('Working');
    default:
      return state;
  }
}

export function SessionStatusBadge({
  snapshot,
  onRaiseBudget,
  onWake,
}: {
  snapshot: SessionRuntimeSnapshot | undefined;
  onRaiseBudget?: () => void;
  onWake?: () => void;
}) {
  if (!snapshot) return null;
  const verdict = budgetVerdict(snapshot.budget.percent);
  const sleeping = snapshot.sleeping || snapshot.state === 'sleeping';

  return (
    <div
      data-testid="session-status-badge"
      data-state={snapshot.state}
      data-sleeping={sleeping ? 'true' : 'false'}
      data-budget-verdict={verdict}
      className="flex items-center gap-2 text-xs text-text-secondary"
    >
      <span
        className={
          sleeping
            ? 'bg-fill-tsp text-text-tertiary'
            : verdict === 'stop'
              ? 'bg-function-warning/10 text-function-warning'
              : verdict === 'warn'
                ? 'bg-function-warning/10 text-function-warning'
                : 'bg-fill-tsp text-func-success'
        }
        data-testid="session-status-pill"
      >
        {sessionStateLabel(snapshot.state, sleeping)}
      </span>

      {snapshot.budget.percent > 0 && (
        <span data-testid="session-budget" title={formatBudget(snapshot.budget)}>
          {t('Budget used')} {snapshot.budget.percent}%
        </span>
      )}

      {verdict !== 'ok' && onRaiseBudget && (
        <button type="button" onClick={onRaiseBudget} data-testid="session-budget-raise">
          {t('Raise budget')}
        </button>
      )}

      {sleeping && onWake && (
        <button type="button" onClick={onWake} data-testid="session-wake">
          {t('Resume')}
        </button>
      )}
    </div>
  );
}
