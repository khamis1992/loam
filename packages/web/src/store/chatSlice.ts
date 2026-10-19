import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  content: string;
}

export interface ChatState {
  messages: ChatMessage[];
  running: boolean;
  statusText: string;
}

const initialState: ChatState = {
  messages: [],
  running: false,
  statusText: '',
};

export const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    addMessage(state, action: PayloadAction<ChatMessage>) {
      state.messages.push(action.payload);
    },
    setRunning(state, action: PayloadAction<boolean>) {
      state.running = action.payload;
    },
    setStatusText(state, action: PayloadAction<string>) {
      state.statusText = action.payload;
    },
    resetChat(state) {
      state.messages = [];
      state.running = false;
      state.statusText = '';
    },
  },
});

export const { addMessage, setRunning, setStatusText, resetChat } = chatSlice.actions;
