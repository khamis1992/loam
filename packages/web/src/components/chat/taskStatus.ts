import type { CascadeTaskClockEvent } from '@shared/socket';

export type TaskVisualStatus = 'Working' | 'Stopped' | 'Task failed' | 'Task completed' | 'Thinking';

export function taskVisualStatus(input: {
  running: boolean;
  wasStoppedByUser: boolean;
  failed: boolean;
  hasResult: boolean;
  hasClockClosed: boolean;
}): TaskVisualStatus {
  if (input.running) return 'Working';
  if (input.wasStoppedByUser) return 'Stopped';
  if (input.failed) return 'Task failed';
  if (input.hasResult && input.hasClockClosed) return 'Task completed';
  return 'Thinking';
}

export function computeTaskClockDuration(clockEvent: CascadeTaskClockEvent, terminalAt?: number): number {
  const { clock, timestamp } = clockEvent;
  const end = clock.phase === 'open' ? (terminalAt ?? Date.now()) : timestamp;
  if (clock.startedAt && end > clock.startedAt) return end - clock.startedAt;
  const ms = clock.accumulatedMs ?? 0;
  return ms > 1_000_000_000 ? Math.floor(ms / 1000) : ms;
}
