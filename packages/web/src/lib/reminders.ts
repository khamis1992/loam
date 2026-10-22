/**
 * Harness reminders (stale todo list, external file change, plan mode, memory
 * update) are injected into the model transcript as user-role tagged blocks.
 * They are model-facing context only and must never render in the UI.
 *
 * The tag mirrors `REMINDER_TAG` in `src/agent/reminders.ts`; keep the two in
 * sync when the tag changes.
 */
export const REMINDER_TAG = "system-reminder";
export const REMINDER_OPEN = `<${REMINDER_TAG}>`;
export const REMINDER_CLOSE = `</${REMINDER_TAG}>`;

/** True when content is exactly one reminder block. */
export function isReminderContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith(REMINDER_OPEN) && trimmed.endsWith(REMINDER_CLOSE);
}

/** True when a message is a harness reminder. */
export function isReminderMessage(message: { role: string; content: string }): boolean {
  return message.role === "user" && isReminderContent(message.content);
}

/** Drop reminders so a transcript never renders harness context. */
export function visibleMessages<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
  return messages.filter((m) => !isReminderMessage(m));
}
