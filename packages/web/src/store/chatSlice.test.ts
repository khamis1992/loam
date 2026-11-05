import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@shared/socket';
import reducer, { appendEvent } from './chatSlice';

function errorEvent(id: string, message: string): ChatEvent {
  return { id, type: 'error', timestamp: 1, message } as unknown as ChatEvent;
}

describe('chatSlice error events', () => {
  it('deduplicates the same error even when event ids differ', () => {
    let state = reducer(undefined, appendEvent({ sessionId: 's', event: errorEvent('e1', 'failed') }));
    state = reducer(state, appendEvent({ sessionId: 's', event: errorEvent('e2', 'failed') }));
    expect(state.eventsBySession.s).toHaveLength(1);
  });

  it('preserves different errors', () => {
    let state = reducer(undefined, appendEvent({ sessionId: 's', event: errorEvent('e1', 'first') }));
    state = reducer(state, appendEvent({ sessionId: 's', event: errorEvent('e2', 'second') }));
    expect(state.eventsBySession.s).toHaveLength(2);
  });
});
