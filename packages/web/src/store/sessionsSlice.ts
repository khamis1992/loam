import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface AgentSession {
  uid: string;
  title: string;
  icon: string;
  status: number; // SessionStatus numeric
  lastMessageTime: number;
  isFollowed: boolean;
  isFavorite: boolean;
  unreadMessageCount: number;
}

export interface SessionsState {
  list: AgentSession[];
  activeUid: string | null;
  filter: 'all' | 'favorites';
  draft: { title: string } | null;
}

const initialState: SessionsState = {
  list: [],
  activeUid: null,
  filter: 'all',
  draft: null,
};

export const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    setSessions(state, action: PayloadAction<AgentSession[]>) {
      state.list = action.payload;
    },
    selectSession(state, action: PayloadAction<string>) {
      state.activeUid = action.payload;
    },
    startNewTask(state) {
      state.activeUid = null;
      state.draft = { title: '' };
    },
    setFilter(state, action: PayloadAction<SessionsState['filter']>) {
      state.filter = action.payload;
    },
  },
});

export const { setSessions, selectSession, startNewTask, setFilter } = sessionsSlice.actions;
