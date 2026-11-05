import { describe, expect, it } from 'vitest';
import type { CascadeTaskClockEvent } from '@shared/socket';
import { computeTaskClockDuration, taskVisualStatus } from '../taskStatus';

const base = { running: false, wasStoppedByUser: false, failed: false, hasResult: false, hasClockClosed: false };

function clock(phase: 'open' | 'closed'): CascadeTaskClockEvent {
  return {
    id: 'clock-1',
    type: 'cascadeTaskClock',
    timestamp: 12_000,
    clock: { sessionId: 's', taskId: 't', startedAt: 10_000, accumulatedMs: 0, phase, revision: 1 },
  };
}

describe('task visual status', () => {
  it('reports a terminal error instead of Thinking', () => {
    expect(taskVisualStatus({ ...base, failed: true })).toBe('Task failed');
  });

  it('keeps successful and active states distinct', () => {
    expect(taskVisualStatus({ ...base, running: true })).toBe('Working');
    expect(taskVisualStatus({ ...base, hasResult: true, hasClockClosed: true })).toBe('Task completed');
  });
});

describe('task clock', () => {
  it('freezes an open clock at the terminal error timestamp', () => {
    expect(computeTaskClockDuration(clock('open'), 11_500)).toBe(1_500);
  });

  it('uses the closed event timestamp', () => {
    expect(computeTaskClockDuration(clock('closed'))).toBe(2_000);
  });
});
