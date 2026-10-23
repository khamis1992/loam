import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EnvironmentIssueCard } from '../EnvironmentIssueCard';
import type { EnvironmentIssueEvent } from '@shared/socket';

function issue(overrides: Partial<EnvironmentIssueEvent> = {}): EnvironmentIssueEvent {
  return {
    id: 'e1',
    type: 'environmentIssue',
    timestamp: 0,
    message: 'npm ci failed: no network',
    ...overrides,
  };
}

describe('EnvironmentIssueCard', () => {
  it('renders the issue message and the continue-guidance', () => {
    render(<EnvironmentIssueCard issue={issue()} />);
    expect(screen.getByText('Environment issue')).toBeInTheDocument();
    expect(screen.getByText('npm ci failed: no network')).toBeInTheDocument();
    expect(screen.getByText(/relying on CI/i)).toBeInTheDocument();
    expect(screen.getByText(/Do not report the step as passed/i)).toBeInTheDocument();
  });

  it('renders optional details', () => {
    render(<EnvironmentIssueCard issue={issue({ details: 'ENOENT: no such file or directory' })} />);
    expect(screen.getByText('ENOENT: no such file or directory')).toBeInTheDocument();
  });

  it('omits the details block when none are supplied', () => {
    const { container } = render(<EnvironmentIssueCard issue={issue()} />);
    expect(container.querySelector('pre')).toBeNull();
  });
});
