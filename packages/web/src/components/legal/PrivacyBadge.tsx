'use client';

import { t } from '@/i18n/t';

export function PrivacyBadge({ local, keyAvailable }: { local: boolean; keyAvailable: boolean }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${local && keyAvailable ? 'border-emerald-600/50 text-emerald-700 dark:text-emerald-300' : 'border-red-600/50 text-red-700 dark:text-red-300'}`}>
      {local && keyAvailable ? t('Local encrypted processing') : t('Protection unavailable')}
    </span>
  );
}
