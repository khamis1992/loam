'use client';

import { ReactNode, useEffect } from 'react';
import { Provider } from 'react-redux';
import { store, useAppSelector, useAppDispatch } from '@/store';
import { setTheme, setLocale, openSettings } from '@/store';
import { setLocale as setDocumentLocale } from '@/i18n/t';

const THEME_KEY = 'agent-studio:theme';
const LOCALE_KEY = 'agent-studio:locale';

type StoredTheme = 'light' | 'dark' | 'system';

function readStoredTheme(): StoredTheme | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(THEME_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return null;
}

function readStoredLocale(): 'en' | 'ar' | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(LOCALE_KEY);
  if (raw === 'en' || raw === 'ar') return raw;
  return null;
}

function LocaleWrapper({ children }: { children: ReactNode }) {
  const locale = useAppSelector((s) => s.ui.locale);
  // Remount the entire app tree when the locale changes so that every t() call
  // is re-evaluated against the new catalog.
  return <div key={locale}>{children}</div>;
}

function ShellSync() {
  const dispatch = useAppDispatch();
  const theme = useAppSelector((s) => s.ui.theme);
  const effectiveTheme = useAppSelector((s) => s.ui.effectiveTheme);
  const locale = useAppSelector((s) => s.ui.locale);
  const density = useAppSelector((s) => s.ui.density);

  // Restore persisted preferences on first client render
  useEffect(() => {
    const forced = (typeof window !== 'undefined' && (window as unknown as { __FORCE_LOCALE__?: string }).__FORCE_LOCALE__);
    if (forced === 'en' || forced === 'ar') {
      dispatch(setLocale(forced));
    } else {
      const storedLocale = readStoredLocale();
      if (storedLocale) dispatch(setLocale(storedLocale));
    }

    const storedTheme = readStoredTheme();
    if (storedTheme) dispatch(setTheme(storedTheme));
  }, [dispatch]);

  // Apply theme class / attributes and persist
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    html.classList.remove('light', 'dark');
    html.classList.add(effectiveTheme);
    html.setAttribute('data-theme', theme);
    html.setAttribute('data-interface-density', density);

    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {}

    // Notify the Electron main process when running under the desktop shell
    try {
      const themeApi = (window as any).__apis?.theme;
      if (typeof themeApi?.setTheme === 'function') {
        themeApi.setTheme(theme);
      }
    } catch {}

    // Recompute system theme when the media query changes
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const applySystem = () => {
      const next = mq.matches ? 'dark' : 'light';
      html.classList.remove('light', 'dark');
      html.classList.add(next);
    };
    applySystem();
    mq.addEventListener('change', applySystem);
    return () => mq.removeEventListener('change', applySystem);
  }, [theme, effectiveTheme, density]);

  // Apply locale attributes and persist
  useEffect(() => {
    setDocumentLocale(locale);
    try {
      window.localStorage.setItem(LOCALE_KEY, locale);
    } catch {}
  }, [locale]);

  return null;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as any).__testOpenSettings = (tab?: string) => {
      store.dispatch(openSettings(tab));
    };
  }, []);
  return (
    <Provider store={store}>
      <ShellSync />
      <LocaleWrapper>{children}</LocaleWrapper>
    </Provider>
  );
}
