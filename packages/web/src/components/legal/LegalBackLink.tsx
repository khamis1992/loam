import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { getLocale, isRtl, t } from '@/i18n/t';

export function LegalBackLink({ href = '/', label }: { href?: string; label?: string }) {
  const Icon = isRtl(getLocale()) ? ArrowRight : ArrowLeft;
  return (
    <Link href={href} aria-label={label ?? t('Back')} className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:hover:bg-zinc-800">
      <Icon aria-hidden="true" className="size-4" />
      <span>{label ?? t('Back')}</span>
    </Link>
  );
}
