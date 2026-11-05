'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { BudgetApp } from '@/components/templates/BudgetApp';
import { t } from '@/i18n/t';

export default function BudgetTemplatePage() {
  const router = useRouter();

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[#08111f]">
      <div className="flex h-row items-center gap-2 border-b border-white/10 px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          aria-label={t('Back')}
          className="rounded-control p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="size-4 rtl:rotate-180" />
        </button>
        <h1 className="text-sm font-medium text-white">{t('Build a personal budget app')}</h1>
      </div>
      <div className="min-h-0 flex-1">
        <BudgetApp />
      </div>
    </div>
  );
}
