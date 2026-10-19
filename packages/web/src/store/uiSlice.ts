import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { setLocale, type Locale } from '@/i18n/t';

export type Theme = 'light' | 'dark' | 'system';
export type Density = 'standard' | 'compact';

interface UIState {
  theme: Theme;
  effectiveTheme: 'light' | 'dark';
  locale: Locale;
  density: Density;
  sidebarOpen: boolean;
}

const initialState: UIState = {
  theme: 'light',
  effectiveTheme: 'light',
  locale: 'en',
  density: 'compact',
  sidebarOpen: true,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setTheme(state, action: PayloadAction<Theme>) {
      state.theme = action.payload;
      state.effectiveTheme = action.payload === 'system'
        ? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : action.payload;
    },
    setLocaleState(state, action: PayloadAction<Locale>) {
      state.locale = action.payload;
      setLocale(action.payload);
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
  },
});

export const { setTheme, setLocaleState, setDensity, toggleSidebar, setSidebarOpen } = uiSlice.actions;
export default uiSlice.reducer;
