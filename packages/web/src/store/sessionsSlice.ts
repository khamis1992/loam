import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface AgentSession {
  uid: string;
  title: string;
  icon?: string;
  status: number;
  lastMessageTime?: number;
  lastDisplayMessage?: string;
  isFollowed?: boolean;
}

interface SessionsState {
  list: AgentSession[];
  activeUid: string | null;
  filter: 'all' | 'favorites';
}

const initialState: SessionsState = { list: [], activeUid: null, filter: 'all' };

const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    setSessions(state, action: PayloadAction<AgentSession[]>) {
      state.list = action.payload;
    },
    addSession(state, action: PayloadAction<AgentSession>) {
      state.list = [action.payload, ...state.list.filter((s) => s.uid !== action.payload.uid)];
      state.activeUid = action.payload.uid;
    },
    selectSession(state, action: PayloadAction<string>) {
      state.activeUid = action.payload;
    },
    startNewTask(state) {
      state.activeUid = null;
    },
    updateSession(state, action: PayloadAction<Partial<AgentSession> & { uid: string }>) {
      const idx = state.list.findIndex((s) => s.uid === action.payload.uid);
      if (idx >= 0) state.list[idx] = { ...state.list[idx], ...action.payload };
    },
    setFilter(state, action: PayloadAction<SessionsState['filter']>) {
      state.filter = action.payload;
    },
  },
});

export const { setSessions, addSession, selectSession, startNewTask, updateSession, setFilter } = sessionsSlice.actions;
export default sessionsSlice.reducer;
