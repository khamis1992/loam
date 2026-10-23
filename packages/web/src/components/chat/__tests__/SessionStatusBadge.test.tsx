import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { SessionStatusBadge, budgetVerdict, formatBudget, sessionStateLabel } from '../SessionStatusBadge';
import { setLocale } from '@/i18n/t';
import type { SessionRuntimeSnapshot } from '../SessionStatusBadge';

function snapshot(overrides: Partial<SessionRuntimeSnapshot> = {}): SessionRuntimeSnapshot {
  return {
    state: 'active',
    sleeping: false,
    budget: { steps: 1, stepLimit: 10, tokens: 10, tokenLimit: 100, percent: 10, stopped: false },
    raised: false,
    ...overrides,
  };
}

afterEach(() => {
  setLocale('en');
  vi.restoreAllMocks();
});

describe('budgetVerdict', () => {
  it('allows work below 80%', () => {
    expect(budgetVerdict(0)).toBe('ok');
    expect(budgetVerdict(79)).toBe('ok');
  });

  it('warns at exactly 80%', () => {
    expect(budgetVerdict(80)).toBe('warn');
    expect(budgetVerdict(99)).toBe('warn');
  });

  it('stops at 100%', () => {
    expect(budgetVerdict(100)).toBe('stop');
    expect(budgetVerdict(150)).toBe('stop');
  });
});

describe('formatBudget', () => {
  it('shows the ceilings when they exist', () => {
    expect(formatBudget({ steps: 8, stepLimit: 10, tokens: 120, tokenLimit: 500, percent: 24, stopped: false }))
      .toBe('steps 8/10 · tokens 120/500');
  });

  it('omits the ceilings when the budget is unlimited', () => {
    expect(formatBudget({ steps: 3, tokens: 42, percent: 0, stopped: false })).toBe('steps 3 · tokens 42');
  });
});

describe('sessionStateLabel', () => {
  it('labels a sleeping session in both locales', () => {
    setLocale('en');
    expect(sessionStateLabel('sleeping', true)).toBe('Sleeping');
    setLocale('ar');
    expect(sessionStateLabel('sleeping', true)).toBe('في وضع السكون');
  });

  it('labels idle as waiting on the user', () => {
    setLocale('en');
    expect(sessionStateLabel('idle', false)).toBe('Waiting for user...');
  });

  it('labels active and awake as working', () => {
    setLocale('en');
    expect(sessionStateLabel('active', false)).toBe('Working');
    expect(sessionStateLabel('awake', false)).toBe('Working');
  });
});

describe('SessionStatusBadge', () => {
  it('renders nothing without a snapshot', () => {
    const { container } = render(<SessionStatusBadge snapshot={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the working pill and hides the budget while usage is zero', () => {
    render(<SessionStatusBadge snapshot={snapshot({ budget: { steps: 0, stepLimit: 40, tokens: 0, tokenLimit: 500000, percent: 0, stopped: false } })} />);
    expect(screen.getByTestId('session-status-pill')).toHaveTextContent('Working');
    expect(screen.queryByTestId('session-budget')).toBeNull();
  });

  it('reports the budget percentage and the warn verdict at 80%', () => {
    render(<SessionStatusBadge snapshot={snapshot({ budget: { steps: 8, stepLimit: 10, tokens: 0, tokenLimit: 100, percent: 80, stopped: false } })} />);
    expect(screen.getByTestId('session-budget')).toHaveTextContent('Budget used 80%');
    expect(screen.getByTestId('session-status-badge')).toHaveAttribute('data-budget-verdict', 'warn');
  });

  it('offers a raise button at the stop verdict and calls back', () => {
    const onRaiseBudget = vi.fn();
    render(
      <SessionStatusBadge
        snapshot={snapshot({ budget: { steps: 10, stepLimit: 10, tokens: 0, tokenLimit: 100, percent: 100, stopped: true } })}
        onRaiseBudget={onRaiseBudget}
      />,
    );
    expect(screen.getByTestId('session-status-badge')).toHaveAttribute('data-budget-verdict', 'stop');
    fireEvent.click(screen.getByTestId('session-budget-raise'));
    expect(onRaiseBudget).toHaveBeenCalledTimes(1);
  });

  it('shows the sleeping pill and a wake button for a sleeping session', () => {
    const onWake = vi.fn();
    render(
      <SessionStatusBadge
        snapshot={snapshot({ state: 'sleeping', sleeping: true })}
        onWake={onWake}
      />,
    );
    expect(screen.getByTestId('session-status-pill')).toHaveTextContent('Sleeping');
    expect(screen.getByTestId('session-status-badge')).toHaveAttribute('data-sleeping', 'true');
    fireEvent.click(screen.getByTestId('session-wake'));
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});
