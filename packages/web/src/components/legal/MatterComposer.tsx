'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { t } from '@/i18n/t';
import { activeLegalMatterId, setActiveLegalMatterId } from '@/services/legalApi';

export function MatterComposer() {
  const [matterId, setMatterId] = useState<string | null>(null);
  useEffect(() => { setMatterId(activeLegalMatterId()); }, []);
  if (!matterId) return null;
  return (
    <div className="mb-2 flex items-center gap-2 rounded-control border border-teal-600/40 px-2 py-1 text-xs">
      <span>{t('Active legal matter')}</span>
      <Link href={`/legal/${matterId}`} className="text-teal-700 underline dark:text-teal-300" dir="ltr">{matterId}</Link>
      <button type="button" className="ms-auto opacity-70" onClick={() => { setActiveLegalMatterId(null); setMatterId(null); }}>{t('Clear')}</button>
    </div>
  );
}
