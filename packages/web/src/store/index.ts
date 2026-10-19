import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';

export interface User {
  uid: string;
  email: string;
  displayname: string;
  avatar: string;
}

const authSlice = createSlice({
  name: 'auth',
  initialState: { user: null as User | null, token: null as string | null },
  reducers: {
    setUser: (state, action: PayloadAction<User | null>) => { state.user = action.payload; },
    setToken: (state, action: PayloadAction<string | null>) => { state.token = action.payload; },
    logout: (state) => { state.user = null; state.token = null; },
  },
});

export interface Session {
  uid: string;
  title: string;
  status: string;
  lastMessageTime?: string;
  icon?: string;
}

const sessionsSlice = createSlice({
  name: 'sessions',
  initialState: { list: [] as Session[], activeUid: null as string | null },
  reducers: {
    setSessions: (state, action: PayloadAction<Session[]>) => { state.list = action.payload; },
    selectSession: (state, action: PayloadAction<string | null>) => { state.activeUid = action.payload; },
    addSession: (state, action: PayloadAction<Session>) => { state.list.unshift(action.payload); },
  },
});

type ThemeMode = 'light' | 'dark' | 'system';
type Density = 'standard' | 'compact';
type Locale = 'en' | 'ar';

export interface UiState {
  theme: ThemeMode;
  density: Density;
  locale: Locale;
  settingsOpen: boolean;
  settingsTab: string;
  updateStatus: UpdateState;
  activityIndicatorOpen: boolean;
}

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version?: string }
  | { state: 'downloading'; progress: number }
  | { state: 'downloaded'; version?: string }
  | { state: 'restarting' }
  | { state: 'error'; message?: string }
  | { state: 'store-managed'; store?: string };

const initialUi: UiState = {
  theme: 'light',
  density: 'compact',
  locale: 'en',
  settingsOpen: false,
  settingsTab: 'General',
  updateStatus: { state: 'idle' },
  activityIndicatorOpen: false,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState: initialUi,
  reducers: {
    setTheme: (state, action: PayloadAction<ThemeMode>) => { state.theme = action.payload; },
    setDensity: (state, action: PayloadAction<Density>) => { state.density = action.payload; },
    setLocale: (state, action: PayloadAction<Locale>) => { state.locale = action.payload; },
    openSettings: (state, action: PayloadAction<string | undefined>) => {
      state.settingsOpen = true;
      if (action.payload) state.settingsTab = action.payload;
    },
    closeSettings: (state) => { state.settingsOpen = false; },
    setSettingsTab: (state, action: PayloadAction<string>) => { state.settingsTab = action.payload; },
    setUpdateStatus: (state, action: PayloadAction<UpdateState>) => { state.updateStatus = action.payload; },
    setActivityIndicatorOpen: (state, action: PayloadAction<boolean>) => { state.activityIndicatorOpen = action.payload; },
  },
});

export const store = configureStore({
  reducer: {
    auth: authSlice.reducer,
    sessions: sessionsSlice.reducer,
    ui: uiSlice.reducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

export const { setUser, setToken, logout } = authSlice.actions;
export const { setSessions, selectSession, addSession } = sessionsSlice.actions;
export const { setTheme, setDensity, setLocale, openSettings, closeSettings, setSettingsTab, setUpdateStatus, setActivityIndicatorOpen } = uiSlice.actions;
