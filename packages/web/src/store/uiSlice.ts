import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type Theme = 'light' | 'dark' | 'auto';
export type Density = 'standard' | 'compact';

export interface UIState {
  theme: Theme;
  density: Density;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
}

const initialState: UIState = {
  theme: 'light',
  density: 'compact',
  sidebarOpen: true,
  rightPanelOpen: false,
};

export const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setTheme(state, action: PayloadAction<Theme>) {
      state.theme = action.payload;
    },
    setDensity(state, action: PayloadAction<Density>) {
      state.density = action.payload;
    },
    toggleSidebar(state) {
      state.sidebarOpen = !state.sidebarOpen;
    },
    toggleRightPanel(state) {
      state.rightPanelOpen = !state.rightPanelOpen;
    },
  },
});

export const { setTheme, setDensity, toggleSidebar, toggleRightPanel } = uiSlice.actions;
