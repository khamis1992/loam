import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { CacheUsageRow } from '../CacheUsageRow';
import { ChatEventRow } from '../EventList';
import type { CacheUsageEvent } from '@shared/socket';

function cacheEvent(overrides: Partial<CacheUsageEvent> = {}): CacheUsageEvent {
  return {
    id: 'evt_cache',
    type: 'cache_usage',
    timestamp: 1,
    provider: 'openai-api',
    model: 'gpt-5.4',
    promptTokens: 120_000,
    cachedTokens: 96_000,
    ...overrides,
  };
}

describe('CacheUsageRow', () => {
  it('shows the reusable-token counters and reuse ratio', () => {
    render(<CacheUsageRow e={cacheEvent()} />);
    const row = screen.getByTestId('cache-usage');
    expect(within(row).getByText(/Prompt cache/)).toBeTruthy();
    expect(within(row).getByText(/openai-api/)).toBeTruthy();
    expect(within(row).getByText(/gpt-5\.4/)).toBeTruthy();
    expect(within(row).getByText(/96000 tokens reused/)).toBeTruthy();
    expect(within(row).getByText(/80%/)).toBeTruthy();
    expect(screen.queryByTestId('cache-usage-miss')).toBeNull();
  });

  it('renders the classified miss reason when the provider reported one', () => {
    render(
      <CacheUsageRow
        e={cacheEvent({
          promptTokens: 120_000,
          cachedTokens: 0,
          miss: {
            reason: 'provider_switch',
            expectedTokens: 118_000,
            readTokens: 0,
            missedTokens: 118_000,
            message: 'KV cache miss [provider_switch]: ~118K tokens resent (provider switched openai-api -> openrouter).',
          },
        })}
      />,
    );
    expect(screen.getByTestId('cache-usage-miss').textContent).toContain('~118K tokens resent');
    expect(screen.getByTestId('cache-usage-miss').textContent).toContain('provider switched openai-api -> openrouter');
  });

  it('keeps a zero-prompt row readable without dividing by zero', () => {
    render(<CacheUsageRow e={cacheEvent({ promptTokens: 0, cachedTokens: 0 })} />);
    expect(screen.getByTestId('cache-usage').textContent).toContain('0%');
  });
});

describe('ChatEventRow cache_usage wiring', () => {
  it('renders the notice through the shared event list switch', () => {
    render(<ChatEventRow e={cacheEvent()} sessionId="s1" />);
    expect(screen.getByTestId('cache-usage')).toBeTruthy();
  });
});
