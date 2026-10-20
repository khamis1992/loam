import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';

const STORAGE_KEY = 'agent-studio:sessions';

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
  loading: boolean;
}

const initialState: SessionsState = { list: [], activeUid: null, filter: 'all', loading: false };

export const loadSessions = createAsyncThunk('sessions/loadSessions', async () => {
  if (typeof window === 'undefined') return [] as AgentSession[];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [] as AgentSession[];
    const parsed = JSON.parse(raw) as AgentSession[];
    return Array.isArray(parsed) ? parsed : ([] as AgentSession[]);
  } catch {
    return [] as AgentSession[];
  }
});

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
    renameSession(state, action: PayloadAction<{ uid: string; title: string }>) {
      const idx = state.list.findIndex((s) => s.uid === action.payload.uid);
      if (idx >= 0) {
        state.list[idx].title = action.payload.title;
        state.list[idx].lastMessageTime = Date.now();
      }
    },
    deleteSession(state, action: PayloadAction<string>) {
      state.list = state.list.filter((s) => s.uid !== action.payload);
      if (state.activeUid === action.payload) state.activeUid = null;
    },
    setFilter(state, action: PayloadAction<SessionsState['filter']>) {
      state.filter = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadSessions.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadSessions.fulfilled, (state, action) => {
        state.list = action.payload;
        state.loading = false;
      })
      .addCase(loadSessions.rejected, (state) => {
        state.loading = false;
      });
  },
});

export const {
  setSessions,
  addSession,
  selectSession,
  startNewTask,
  updateSession,
  renameSession,
  deleteSession,
  setFilter,
} = sessionsSlice.actions;
export default sessionsSlice.reducer;
