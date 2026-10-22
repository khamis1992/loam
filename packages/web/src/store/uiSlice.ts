import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { setLocale as setDocumentLocale, type Locale } from '@/i18n/t';

export type Theme = 'light' | 'dark' | 'system';
export type Density = 'standard' | 'compact';

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version?: string }
  | { state: 'downloading'; progress: number }
  | { state: 'downloaded'; version?: string }
  | { state: 'restarting' }
  | { state: 'error'; message?: string }
  | { state: 'store-managed'; store?: string };

interface UIState {
  theme: Theme;
  effectiveTheme: 'light' | 'dark';
  locale: Locale;
  density: Density;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  settingsTab: string;
  updateStatus: UpdateState;
  activityIndicatorOpen: boolean;
}

const initialState: UIState = {
  theme: 'light',
  effectiveTheme: 'light',
  locale: 'en',
  density: 'compact',
  sidebarOpen: true,
  settingsOpen: false,
  settingsTab: 'General',
  updateStatus: { state: 'idle' },
  activityIndicatorOpen: false,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setTheme(state, action: PayloadAction<Theme>) {
      state.theme = action.payload;
      if (action.payload !== 'system') {
        state.effectiveTheme = action.payload;
      }
    },
    setEffectiveTheme(state, action: PayloadAction<'light' | 'dark'>) {
      state.effectiveTheme = action.payload;
    },
    setLocale(state, action: PayloadAction<Locale>) {
      state.locale = action.payload;
      setDocumentLocale(action.payload);
    },
    setDensity(state, action: PayloadAction<Density>) {
      state.density = action.payload;
    },
    toggleSidebar(state) {
      state.sidebarOpen = !state.sidebarOpen;
    },
    setSidebarOpen(state, action: PayloadAction<boolean>) {
      state.sidebarOpen = action.payload;
    },
    openSettings(state, action: PayloadAction<string | undefined>) {
      state.settingsOpen = true;
      if (action.payload) state.settingsTab = action.payload;
    },
    closeSettings(state) {
      state.settingsOpen = false;
    },
    setSettingsTab(state, action: PayloadAction<string>) {
      state.settingsTab = action.payload;
    },
    setUpdateStatus(state, action: PayloadAction<UpdateState>) {
      state.updateStatus = action.payload;
    },
    setActivityIndicatorOpen(state, action: PayloadAction<boolean>) {
      state.activityIndicatorOpen = action.payload;
    },
  },
});

export const {
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
} = uiSlice.actions;
export default uiSlice.reducer;
