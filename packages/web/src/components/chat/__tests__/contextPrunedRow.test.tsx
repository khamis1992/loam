import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ContextPrunedRow } from '../ContextPrunedRow';
import { ChatEventRow } from '../EventList';
import type { ContextPrunedEvent } from '@shared/socket';

function prunedEvent(overrides: Partial<ContextPrunedEvent> = {}): ContextPrunedEvent {
  return {
    id: 'evt_pruned',
    type: 'context_pruned',
    timestamp: 1,
    strategy: 'prune_then_summary',
    scorer: 'heuristic',
    fallback: false,
    kept: 4,
    truncated: 3,
    dropped: 2,
    pinned: 1,
    charsBefore: 120_000,
    charsAfter: 40_000,
    tokensBefore: 30_000,
    tokensAfter: 10_000,
    ...overrides,
  };
}

describe('ContextPrunedRow', () => {
  it('shows how many results were omitted and the token change', () => {
    render(<ContextPrunedRow e={prunedEvent()} />);
    const text = screen.getByTestId('context-pruned').textContent ?? '';
    expect(text).toContain('Context trimmed');
    expect(text).toContain('5 results omitted');
    expect(text).toContain('30000 to 10000 tokens');
  });

  it('renders through the shared event list switch', () => {
    render(<ChatEventRow e={prunedEvent()} sessionId="s1" />);
    expect(screen.getByTestId('context-pruned')).toBeTruthy();
  });
});
