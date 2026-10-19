'use client';

import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { useMemo } from 'react';
import { useSelector as useReduxSelector, useDispatch as useReduxDispatch, type TypedUseSelectorHook } from 'react-redux';
import { authSlice } from './authSlice';
import { sessionsSlice } from './sessionsSlice';
import { websocketSlice } from './websocketSlice';
import { chatSlice } from './chatSlice';
import { projectSlice } from './projectSlice';
import { uiSlice } from './uiSlice';

export type RootState = ReturnType<ReturnType<typeof makeStore>['getState']>;
export type AppDispatch = ReturnType<typeof makeStore>['dispatch'];

export function makeStore() {
  return configureStore({
    reducer: {
      auth: authSlice.reducer,
      sessions: sessionsSlice.reducer,
      websocket: websocketSlice.reducer,
      chat: chatSlice.reducer,
      project: projectSlice.reducer,
      ui: uiSlice.reducer,
    },
  });
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => makeStore(), []);
  return <Provider store={store}>{children}</Provider>;
}

export const useAppSelector: TypedUseSelectorHook<RootState> = useReduxSelector;
export const useAppDispatch = () => useReduxDispatch<AppDispatch>();
