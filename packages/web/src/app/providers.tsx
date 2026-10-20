'use client';

import { useEffect } from 'react';
import { Provider } from 'react-redux';
import { store, useAppSelector } from '@/store';
import { setLocale } from '@/store/uiSlice';

function LocaleInit({ children }: { children: React.ReactNode }) {
  const locale = useAppSelector((s) => s.ui.locale);
  useEffect(() => {
    const forced = (typeof window !== 'undefined' && (window as unknown as { __FORCE_LOCALE__?: string }).__FORCE_LOCALE__);
    if (forced && (forced === 'en' || forced === 'ar')) {
      store.dispatch(setLocale(forced));
    }
  }, []);
  // Remount the entire app tree when the locale changes so t() is re-evaluated.
  return <div key={locale}>{children}</div>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <Provider store={store}>
      <LocaleInit>{children}</LocaleInit>
    </Provider>
  );
}
