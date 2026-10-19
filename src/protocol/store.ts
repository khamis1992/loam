import type { ServerEnvelope } from "./types.js";
import { createEventMapperState, type EventMapperState } from "./events.js";

export interface ProtocolSession {
  sessionId: string;
  taskId: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  mapperState: EventMapperState;
  events: ServerEnvelope[];
}

export class ProtocolStore {
  private sessions = new Map<string, ProtocolSession>();

  ensureSession(sessionId: string, taskId: string, title = "New task"): ProtocolSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      const now = Date.now();
      s = {
        sessionId,
        taskId,
        title,
        status: "SESSION_STATUS_CREATED",
        createdAt: now,
        updatedAt: now,
        mapperState: createEventMapperState(),
        events: [],
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  getSession(sessionId: string): ProtocolSession | undefined {
    return this.sessions.get(sessionId);
  }

  setTaskId(sessionId: string, taskId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.taskId = taskId;
  }

  setTitle(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.title = title;
      s.updatedAt = Date.now();
    }
  }

  setStatus(sessionId: string, status: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.status = status;
      s.updatedAt = Date.now();
    }
  }

  appendEvent(sessionId: string, envelope: ServerEnvelope): void {
    const s = this.ensureSession(sessionId, envelope.sessionId);
    s.updatedAt = Date.now();
    if (!envelope.event.noPersistent) {
      s.events.push(envelope);
    }
  }

  /** Return persisted events with id strictly after lastMessageId. */
  eventsAfter(sessionId: string, lastMessageId?: string): ServerEnvelope[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    if (!lastMessageId) return [...s.events];
    const idx = s.events.findIndex((e) => e.id === lastMessageId);
    return s.events.slice(idx + 1);
  }

  listSessions(): ProtocolSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Test helper: drop all state. */
  clear(): void {
    this.sessions.clear();
  }
}
