import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { AgentSession as ApiSession, Timestamp, SessionStatus } from '@shared/proto';
import { RpcClient, getApiBase, getSessionToken } from '@/services/rpc';

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
  error: string | null;
}

const initialState: SessionsState = { list: [], activeUid: null, filter: 'all', loading: false, error: null };

function statusToNumber(status: SessionStatus | string | number | undefined): number {
  if (typeof status === 'number') return status;
  if (typeof status === 'string') {
    const n = Number(status);
    if (!Number.isNaN(n)) return n;
    const map: Record<string, number> = {
      SESSION_STATUS_UNSPECIFIED: 0,
      SESSION_STATUS_CREATED: 1,
      SESSION_STATUS_ARCHIVED: 2,
      SESSION_STATUS_DELETED: 3,
      SESSION_STATUS_WAITING: 5,
      SESSION_STATUS_RUNNING: 6,
      SESSION_STATUS_STOPPED: 7,
      SESSION_STATUS_ERROR: 8,
      SESSION_STATUS_IN_QUEUE: 9,
    };
    if (map[status] !== undefined) return map[status];
  }
  return 1;
}

function timestampToMs(ts: Timestamp | string | number | undefined): number | undefined {
  if (!ts) return undefined;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') return Date.parse(ts) || undefined;
  const seconds = Number(ts.seconds ?? 0);
  const nanos = Number(ts.nanos ?? 0);
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

function apiSessionToLocal(s: ApiSession): AgentSession {
  return {
    uid: s.uid,
    title: s.title || 'New task',
    icon: s.icon || '•',
    status: statusToNumber(s.status),
    lastMessageTime: timestampToMs(s.lastMessageTime),
    lastDisplayMessage: s.lastDisplayMessage,
    isFollowed: s.isFollowed,
  };
}

/** Load the sidebar task list from the backend. The shell layer dispatches this. */
export const loadSessions = createAsyncThunk('sessions/loadSessions', async () => {
  const client = new RpcClient({ getToken: getSessionToken, apiBase: getApiBase() });
  const res = await client.listSessions({ limit: 100, offset: 0, isArchived: false });
  return (res.sessions ?? []).map(apiSessionToLocal);
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
        state.error = null;
      })
      .addCase(loadSessions.fulfilled, (state, action) => {
        state.loading = false;
        state.list = action.payload;
      })
      .addCase(loadSessions.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? 'failed to load sessions';
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
