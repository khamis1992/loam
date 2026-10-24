'use client';

import { t } from '@/i18n/t';

/**
 * J7: the local "hibernated - type to resume" status.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md: this is *UI state*, not
 * a message sent to the model and not a new conversation turn. It tells the user
 * the derived render caches were released and that typing resumes the session.
 *
 * It is deliberately minimal: no buttons (the first keystroke wakes), no
 * transcript, and no polling of its own: the parent view owns the state.
 */
export function HibernationNotice({ hibernated }: { hibernated: boolean }) {
  if (!hibernated) return null;
  return (
    <div
      data-testid="hibernation-notice"
      data-hibernated="true"
      className="mb-2 flex items-center gap-2 rounded-control bg-fill-tsp px-3 py-2 text-sm text-text-secondary"
    >
      <span aria-hidden="true" className="text-text-tertiary">❄</span>
      <span>{t('Hibernated')} - {t('type to resume')}</span>
    </div>
  );
}
