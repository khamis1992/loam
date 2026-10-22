/**
 * Pure layout helpers for the Grok-style agent thread (AgentThreadView).
 *
 * Kept free of React and i18n imports so the time-separator and bubble
 * alignment rules can be unit-tested directly (see agentThreadLayout.test.ts).
 */

/** Gap after which a new centered day/time separator is inserted. */
export const SEPARATOR_GAP_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ThreadSender = 'user' | 'assistant';

export type BubbleAlign = 'start' | 'end';

/** Localized labels used by {@link separatorLabel}. */
export interface SeparatorLabels {
  today: string;
  yesterday: string;
}

/** Midnight (local) of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** True when both timestamps fall on the same local calendar day. */
export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/**
 * True when a centered separator should precede `nextTs`.
 *
 * A separator is inserted when the day changes or when the gap since the
 * previous message exceeds {@link SEPARATOR_GAP_MS}. The first message
 * (`prevTs` null) never triggers a separator here; the list anchors the
 * thread with an explicit leading header instead.
 */
export function shouldInsertSeparator(prevTs: number | null | undefined, nextTs: number): boolean {
  if (prevTs == null) return false;
  if (!isSameDay(prevTs, nextTs)) return true;
  return nextTs - prevTs > SEPARATOR_GAP_MS;
}

/**
 * "Today 9:02 PM" style label for a separator. Today/Yesterday use the
 * supplied localized labels; older days fall back to a localized weekday +
 * short date. The time is always localized.
 */
export function separatorLabel(ts: number, now: number, locale: string, labels: SeparatorLabels): string {
  const day = isSameDay(ts, now)
    ? labels.today
    : isSameDay(ts, now - DAY_MS)
      ? labels.yesterday
      : new Intl.DateTimeFormat(locale, {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          ...(new Date(ts).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}),
        }).format(ts);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(ts);
  return `${day} ${time}`;
}

/** Which side of the thread a sender's bubble sits on. */
export function bubbleAlign(sender: ThreadSender): BubbleAlign {
  return sender === 'user' ? 'end' : 'start';
}

/**
 * Physical (RTL-safe) auto-margin class pinning a bubble to its side.
 *
 * `justify-end`/`justify-start` follow the flex main axis, which flips under
 * `dir="rtl"`; the auto margins keep the user bubble on the right and the
 * agent bubble on the left in every locale.
 */
export function bubbleAlignClass(sender: ThreadSender): string {
  return sender === 'user' ? 'ml-auto' : 'mr-auto';
}
