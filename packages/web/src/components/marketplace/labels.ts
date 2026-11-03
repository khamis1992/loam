import { getLocale } from '@/i18n/t';

/**
 * Inline bilingual label for words the shared i18n catalog does not carry yet.
 * Same sanctioned shape as LessonsPanel's SOURCE_LABELS: an `{ en, ar }` pair
 * resolved by `getLocale()` — nothing is written into the JSON catalogs from
 * here, and `setLocale('ar')` alone switches the output.
 */
export function bi(en: string, ar: string): string {
  return getLocale() === 'ar' ? ar : en;
}
