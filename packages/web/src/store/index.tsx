'use client';

import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { useMemo } from 'react';
import { useSelector as useReduxSelector, useDispatch as useReduxDispatch, type TypedUseSelectorHook } from 'react-redux';
import authReducer, { setUser, setToken, logout } from './authSlice';
import sessionsReducer, { setSessions, addSession, selectSession, startNewTask, updateSession, setFilter, loadSessions } from './sessionsSlice';
import websocketReducer, { setConnected, setOffline } from './websocketSlice';
import chatReducer, { appendEvent, applyDelta, setStatus, replaceEvents, clearSession, setError } from './chatSlice';
import projectReducer, { setProjects, selectProject } from './projectSlice';
import uiReducer, {
  setTheme,
  setEffectiveTheme,
  setLocale,
  setDensity,
  toggleSidebar,
  setSidebarOpen,
  openSettings,
  closeSettings,
  setSettingsTab,
  setUpdateStatus,
  setActivityIndicatorOpen,
  type UpdateState,
} from './uiSlice';
import appBuilderReducer from './appBuilderSlice';

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const store = configureStore({
  reducer: {
    auth: authReducer,
    sessions: sessionsReducer,
    websocket: websocketReducer,
    chat: chatReducer,
    project: projectReducer,
    ui: uiReducer,
    appBuilder: appBuilderReducer,
  },
});

export function makeStore() {
  return configureStore({
    reducer: {
      auth: authReducer,
      sessions: sessionsReducer,
      websocket: websocketReducer,
      chat: chatReducer,
      project: projectReducer,
      ui: uiReducer,
    appBuilder: appBuilderReducer,
    },
  });
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const s = useMemo(() => makeStore(), []);
  return <Provider store={s}>{children}</Provider>;
}

export const useAppSelector: TypedUseSelectorHook<RootState> = useReduxSelector;
export const useAppDispatch = () => useReduxDispatch<AppDispatch>();

export {
  setUser, setToken, logout,
  setSessions, addSession, selectSession, startNewTask, updateSession, setFilter, loadSessions,
  setConnected, setOffline,
  appendEvent, applyDelta, setStatus, replaceEvents, clearSession, setError,
  setProjects, selectProject,
  setTheme, setEffectiveTheme, setLocale, setDensity, toggleSidebar, setSidebarOpen,
  openSettings, closeSettings, setSettingsTab, setUpdateStatus, setActivityIndicatorOpen,
  type UpdateState,
};
