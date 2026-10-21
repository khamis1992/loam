'use client';

import { t } from '../../i18n/t';

/** Marker the server writes into the agent thread for mirrored Grok Bot notes. */
export const GROKBOT_NOTE_HEADER = 'from Grok Bot:';

/**
 * Read-only inbound note mirrored from Grok Bot. Rendered muted with a "Grok
 * Bot" chip and no action buttons — it must never look like a sendable action.
 */
export function GrokBotNote({ text }: { text: string }) {
  return (
    <div className="ms-auto flex max-w-[80%] flex-col items-end gap-1">
      <span className="rounded-full border border-border-main bg-fill-tsp px-1.5 py-0.5 text-[10px] leading-none text-text-secondary">
        {t('Grok Bot')}
      </span>
      <div className="rounded-card border border-border-main bg-fill-tsp px-3 py-2 text-sm text-text-secondary italic">
        {text}
      </div>
    </div>
  );
}

/** True for user chat events that carry the server's mirrored-note marker. */
export function isGrokBotNote(content: string): boolean {
  return content.startsWith(`${GROKBOT_NOTE_HEADER}\n`);
}

/** Strip the server marker for display. */
export function grokBotNoteText(content: string): string {
  return content.startsWith(`${GROKBOT_NOTE_HEADER}\n`) ? content.slice(GROKBOT_NOTE_HEADER.length + 1) : content;
}
