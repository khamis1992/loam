import { useCallback } from 'react';
import { getLocale, setLocale, type Locale, isRtl, t } from '@/i18n/t';

export function useLocale() {
  const locale = getLocale();
  const dir = isRtl(locale) ? 'rtl' : 'ltr';
  const switchLocale = useCallback((l: Locale) => {
    setLocale(l);
    // Force re-render by dispatching a custom event that layout listens to
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('localeChanged', { detail: l }));
    }
  }, []);
  return { locale, dir, isRtl: isRtl(locale), switchLocale, t };
}
