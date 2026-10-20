import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ChatEvent, ChatMessageEvent, ChatDeltaEvent, StatusUpdateEvent, ToolUsedEvent } from '@shared/socket';

export interface ChatState {
  eventsBySession: Record<string, ChatEvent[]>;
  deltasByTarget: Record<string, string>;
  statusBySession: Record<string, StatusUpdateEvent['agentStatus']>;
  running: Record<string, boolean>;
  errorsBySession: Record<string, string>;
}

const initialState: ChatState = { eventsBySession: {}, deltasByTarget: {}, statusBySession: {}, running: {}, errorsBySession: {} };

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
      const list = state.eventsBySession[sessionId];
      const idx = list.findIndex((e) => e.id === delta.targetEventId);
      if (idx >= 0) {
        const existing = list[idx];
        if (existing.type === 'chat' && existing.sender === 'assistant') {
          existing.content = state.deltasByTarget[delta.targetEventId];
          if (delta.finished) existing.deliveryKind = 'result';
        }
      } else {
        list.push({
          id: delta.targetEventId,
          type: 'chat',
          timestamp: delta.timestamp,
          sender: 'assistant',
          messageType: 'text',
          content: state.deltasByTarget[delta.targetEventId],
          attachments: [],
          deliveryKind: delta.finished ? 'result' : 'provisional',
        });
      }
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
      delete state.errorsBySession[action.payload];
    },
    setError(state, action: PayloadAction<{ sessionId: string; error: string }>) {
      state.errorsBySession[action.payload.sessionId] = action.payload.error;
    },
  },
});

export const { appendEvent, applyDelta, setStatus, replaceEvents, clearSession, setError } = chatSlice.actions;
export default chatSlice.reducer;

export type { ChatEvent, ChatMessageEvent, ChatDeltaEvent, StatusUpdateEvent, ToolUsedEvent };
