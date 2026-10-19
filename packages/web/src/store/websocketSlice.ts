import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface WebsocketState {
  connected: boolean;
  reconnecting: boolean;
  lastError: string | null;
}

const initialState: WebsocketState = {
  connected: false,
  reconnecting: false,
  lastError: null,
};

export const websocketSlice = createSlice({
  name: 'websocket',
  initialState,
  reducers: {
    setConnected(state, action: PayloadAction<boolean>) {
      state.connected = action.payload;
      if (action.payload) state.reconnecting = false;
    },
    setReconnecting(state, action: PayloadAction<boolean>) {
      state.reconnecting = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.lastError = action.payload;
    },
  },
});

export const { setConnected, setReconnecting, setError } = websocketSlice.actions;
