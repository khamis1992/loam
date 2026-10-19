'use client';

import { ReactNode, useEffect } from 'react';
import { Provider } from 'react-redux';
import { store, openSettings } from '@/store';

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as any).__testOpenSettings = (tab?: string) => {
      store.dispatch(openSettings(tab));
    };
  }, []);
  return <Provider store={store}>{children}</Provider>;
}
