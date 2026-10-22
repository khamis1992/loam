'use client';

import { Suspense } from 'react';
import { ShareReplay } from '@/components/share/ShareReplay';
import { t } from '@/i18n/t';

/**
 * Public read-only share replay (option #11). `/share?t=<token>` and
 * `/share/<token>` both render the same replay; ShareReplay resolves the token
 * from the query or the path.
 */
export default function SharePage() {
  return (
    <Suspense fallback={<div className="grid h-screen place-items-center text-text-secondary">{t('Loading')}</div>}>
      <ShareReplay />
    </Suspense>
  );
}
