import { describe, expect, it } from 'vitest';
import {
  SEPARATOR_GAP_MS,
  bubbleAlign,
  bubbleAlignClass,
  isSameDay,
  separatorLabel,
  shouldInsertSeparator,
  startOfDay,
} from '../agentThreadLayout';

const MINUTE = 60 * 1000;

describe('shouldInsertSeparator', () => {
  const base = new Date(2026, 9, 22, 21, 2, 0).getTime();

  it('does not insert a separator for the first message', () => {
    expect(shouldInsertSeparator(null, base)).toBe(false);
    expect(shouldInsertSeparator(undefined, base)).toBe(false);
  });

  it('inserts when the gap exceeds 30 minutes', () => {
    expect(shouldInsertSeparator(base, base + SEPARATOR_GAP_MS + 1)).toBe(true);
  });

  it('does not insert at or below the 30 minute boundary', () => {
    expect(shouldInsertSeparator(base, base + SEPARATOR_GAP_MS)).toBe(false);
    expect(shouldInsertSeparator(base, base + 10 * MINUTE)).toBe(false);
    expect(shouldInsertSeparator(base, base + 29 * MINUTE)).toBe(false);
  });

  it('inserts when the day changes even inside the gap', () => {
    const justBeforeMidnight = new Date(2026, 9, 22, 23, 55, 0).getTime();
    const justAfterMidnight = new Date(2026, 9, 23, 0, 5, 0).getTime();
    expect(justAfterMidnight - justBeforeMidnight).toBe(10 * MINUTE);
    expect(shouldInsertSeparator(justBeforeMidnight, justAfterMidnight)).toBe(true);
  });

  it('treats messages on the same day within the gap as continuous', () => {
    const a = new Date(2026, 9, 22, 10, 0, 0).getTime();
    const b = new Date(2026, 9, 22, 10, 15, 0).getTime();
    expect(shouldInsertSeparator(a, b)).toBe(false);
  });
});

describe('day helpers', () => {
  it('startOfDay zeroes the local time', () => {
    const d = new Date(2026, 9, 22, 13, 45, 12);
    expect(startOfDay(d.getTime())).toBe(new Date(2026, 9, 22, 0, 0, 0).getTime());
  });

  it('isSameDay compares local calendar days', () => {
    const a = new Date(2026, 9, 22, 23, 59).getTime();
    const b = new Date(2026, 9, 22, 0, 1).getTime();
    expect(isSameDay(a, b)).toBe(true);
    expect(isSameDay(a, new Date(2026, 9, 23, 0, 1).getTime())).toBe(false);
  });
});

describe('separatorLabel', () => {
  const now = new Date(2026, 9, 22, 21, 2, 0).getTime();
  const labels = { today: 'Today', yesterday: 'Yesterday' };

  it('labels a message from today with the localized Today label and time', () => {
    const ts = new Date(2026, 9, 22, 21, 2, 0).getTime();
    expect(separatorLabel(ts, now, 'en', labels)).toMatch(/^Today \d/);
    expect(separatorLabel(ts, now, 'en', labels)).toContain('9:02');
  });

  it('labels a message from yesterday with the localized Yesterday label', () => {
    const ts = new Date(2026, 9, 21, 8, 30, 0).getTime();
    expect(separatorLabel(ts, now, 'en', labels)).toMatch(/^Yesterday \d/);
  });

  it('falls back to a localized weekday + date for older messages', () => {
    const ts = new Date(2026, 9, 15, 18, 0, 0).getTime();
    const label = separatorLabel(ts, now, 'en', labels);
    expect(label).not.toMatch(/^Today/);
    expect(label).not.toMatch(/^Yesterday/);
    expect(label).toContain('Oct 15');
  });

  it('includes the year when the message is from another year', () => {
    const ts = new Date(2025, 8, 15, 18, 0, 0).getTime();
    const label = separatorLabel(ts, now, 'en', labels);
    expect(label).toContain('2025');
  });

  it('uses the supplied locale for the time', () => {
    const ts = new Date(2026, 9, 22, 21, 2, 0).getTime();
    const label = separatorLabel(ts, now, 'ar', labels);
    expect(label.startsWith('Today ')).toBe(true);
    expect(label).not.toBe(separatorLabel(ts, now, 'en', labels));
  });
});

describe('bubble alignment', () => {
  it('aligns user bubbles to the end (right)', () => {
    expect(bubbleAlign('user')).toBe('end');
    expect(bubbleAlignClass('user')).toBe('ml-auto');
  });

  it('aligns assistant bubbles to the start (left)', () => {
    expect(bubbleAlign('assistant')).toBe('start');
    expect(bubbleAlignClass('assistant')).toBe('mr-auto');
  });

  it('uses physical margins so alignment is stable under RTL', () => {
    expect(bubbleAlignClass('user')).not.toContain('justify-');
    expect(bubbleAlignClass('assistant')).not.toContain('justify-');
  });
});
