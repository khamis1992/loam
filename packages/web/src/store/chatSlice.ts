import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ChatEvent, ChatMessageEvent, ChatDeltaEvent, StatusUpdateEvent, ToolUsedEvent } from '@shared/socket';

export interface ChatState {
  eventsBySession: Record<string, ChatEvent[]>;
  deltasByTarget: Record<string, string>;
  statusBySession: Record<string, StatusUpdateEvent['agentStatus']>;
  running: Record<string, boolean>;
}

const initialState: ChatState = { eventsBySession: {}, deltasByTarget: {}, statusBySession: {}, running: {} };

function ensureEvents(state: ChatState, sessionId: string) {
  if (!state.eventsBySession[sessionId]) state.eventsBySession[sessionId] = [];
}

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    appendEvent(state, action: PayloadAction<{ sessionId: string; event: ChatEvent }>) {
      const { sessionId, event } = action.payload;
      ensureEvents(state, sessionId);
      const list = state.eventsBySession[sessionId];
      const idx = list.findIndex((e) => e.id === event.id);
      if (idx >= 0) list[idx] = event;
      else list.push(event);
    },
    applyDelta(state, action: PayloadAction<{ sessionId: string; delta: ChatDeltaEvent }>) {
      const { sessionId, delta } = action.payload;
      ensureEvents(state, sessionId);
      state.deltasByTarget[delta.targetEventId] = (state.deltasByTarget[delta.targetEventId] ?? '') + delta.delta.content;
    },
    setStatus(state, action: PayloadAction<{ sessionId: string; status: StatusUpdateEvent['agentStatus'] }>) {
      const { sessionId, status } = action.payload;
      state.statusBySession[sessionId] = status;
      state.running[sessionId] = status === 'running';
    },
    replaceEvents(state, action: PayloadAction<{ sessionId: string; events: ChatEvent[] }>) {
      state.eventsBySession[action.payload.sessionId] = action.payload.events;
    },
    clearSession(state, action: PayloadAction<string>) {
      delete state.eventsBySession[action.payload];
    },
  },
});

export const { appendEvent, applyDelta, setStatus, replaceEvents, clearSession } = chatSlice.actions;
export default chatSlice.reducer;

export type { ChatEvent, ChatMessageEvent, ChatDeltaEvent, StatusUpdateEvent, ToolUsedEvent };
