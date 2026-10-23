import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EventList } from '../EventList';
import type { EnvironmentIssueEvent } from '@shared/socket';

/** D17: the live chat timeline renders the environment-issue card. This covers the
 *  integration path (EventList -> ChatEventRow -> EnvironmentIssueCard), not just
 *  the card component in isolation, so the card is verified where the user sees it. */
describe('EventList environmentIssue row', () => {
  it('renders the card inside the chat timeline', () => {
    const issue: EnvironmentIssueEvent = {
      id: 'issue-1',
      type: 'environmentIssue',
      timestamp: 0,
      message: 'npm ci failed: no network',
      details: 'ENOTFOUND registry.npmjs.org',
    };

    render(<EventList events={[issue]} sessionId="s1" />);

    expect(screen.getByText('Environment issue')).toBeInTheDocument();
    expect(screen.getByText('npm ci failed: no network')).toBeInTheDocument();
    expect(screen.getByText('ENOTFOUND registry.npmjs.org')).toBeInTheDocument();
    expect(screen.getByText(/relying on CI/i)).toBeInTheDocument();
  });
});
