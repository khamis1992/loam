import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface WebsocketState {
  connected: boolean;
  offline: boolean;
  offlineAt?: number;
  socketId?: string;
}

const initialState: WebsocketState = { connected: false, offline: false };

const websocketSlice = createSlice({
  name: 'websocket',
  initialState,
  reducers: {
    setConnected(state, action: PayloadAction<boolean>) {
      state.connected = action.payload;
      if (action.payload) {
        state.offline = false;
        state.offlineAt = undefined;
      }
    },
    setOffline(state, action: PayloadAction<boolean>) {
      state.offline = action.payload;
      state.offlineAt = action.payload ? Date.now() : undefined;
    },
  },
});

export const { setConnected, setOffline } = websocketSlice.actions;
export default websocketSlice.reducer;
