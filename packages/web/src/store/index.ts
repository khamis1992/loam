import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import authReducer from './authSlice';
import sessionsReducer from './sessionsSlice';
import websocketReducer from './websocketSlice';
import chatReducer from './chatSlice';
import projectReducer from './projectSlice';
import uiReducer from './uiSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    sessions: sessionsReducer,
    websocket: websocketReducer,
    chat: chatReducer,
    project: projectReducer,
    ui: uiReducer,
  },
  middleware: (getDefault) => getDefault({ serializableCheck: false }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
