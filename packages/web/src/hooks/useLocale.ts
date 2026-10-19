import { useEffect, useState } from 'react';
import { getLocale, setLocale, isRtl, type Locale, PRODUCT } from '../i18n/t';

export function useLocale() {
  const [locale, setLoc] = useState<Locale>(getLocale());

  useEffect(() => {
    // Sync in case another caller changed the locale before this hook mounted.
    setLoc(getLocale());
  }, []);

  const changeLocale = (l: Locale) => {
    setLocale(l);
    setLoc(l);
  };

  return {
    locale,
    setLocale: changeLocale,
    dir: isRtl(locale) ? 'rtl' : 'ltr',
    isRtl: isRtl(locale),
    product: PRODUCT,
  };
}
