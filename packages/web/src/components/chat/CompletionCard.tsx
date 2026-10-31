'use client';

import { CheckCircle2, X } from 'lucide-react';
import { t } from '@/i18n/t';

/** H5 + L3 (docs/UI_GAP_ANALYSIS §4): graceful completion moment — a subtle
 *  success card with suggested follow-ups. Clicking a chip FILLS the composer
 *  with the suggestion; it never auto-sends. Dismissible per run. */

const FOLLOW_UPS: { label: string; text: string }[] = [
  {
    label: 'لخّص ما تم إنجازه',
    text: 'لخّص ما تم إنجازه في هذه المهمة في نقاط قصيرة، مع الملفات أو المخرجات الناتجة.',
  },
  {
    label: 'اقترح الخطوة التالية',
    text: 'بناءً على نتيجة هذه المهمة، اقترح الخطوة التالية الأنسب مع سبب واحد مختصر لكل خيار.',
  },
  {
    label: 'راجع النتيجة بحثًا عن مشاكل',
    text: 'راجع مخرجات هذه المهمة بحثًا عن أخطاء أو نواقص، واذكر أي إصلاح مطلوب.',
  },
];

interface CompletionCardProps {
  /** Fills the composer with the follow-up text (never sends). */
  onFill: (text: string) => void;
  onDismiss: () => void;
}

export function CompletionCard({ onFill, onDismiss }: CompletionCardProps) {
  return (
    <div
      data-testid="completion-card"
      role="status"
      className="mb-2 flex flex-col gap-2 rounded-card border border-border-main bg-bg-menu p-3 shadow-card"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 className="size-4 shrink-0 text-func-success" aria-hidden />
        <span className="text-sm font-medium text-text-primary">{t('Task completed')}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={t('Dismiss')}
          onClick={onDismiss}
          className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FOLLOW_UPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            data-testid="follow-up-chip"
            onClick={() => onFill(chip.text)}
            className="flex items-center gap-1.5 rounded-full border border-border-main bg-fill-tsp px-2.5 py-1 text-xs text-text-secondary transition-colors duration-fast hover:bg-fill-hover hover:text-text-primary"
          >
            {chip.label}
            <span className="text-text-tertiary" aria-hidden>→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
