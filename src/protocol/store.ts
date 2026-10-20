import fs from "node:fs";
import path from "node:path";
import type { ServerEnvelope } from "./types.js";
import { createEventMapperState, type EventMapperState } from "./events.js";

function getDataDir(): string {
  const dir = process.env.LOAM_DATA_DIR || process.env.MANUS_LOCAL_DATA_DIR;
  if (dir) return path.resolve(dir);
  return path.resolve("data");
}

const SESSIONS_FILE = path.join(getDataDir(), "protocol-sessions.json");

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

export interface PersistedSession {
  sessionId: string;
  taskId: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  events: ServerEnvelope[];
}

export class ProtocolStore {
  private sessions = new Map<string, ProtocolSession>();
  private taskIdToSessionId = new Map<string, string>();
  private saveTimer?: NodeJS.Timeout;

  constructor() {
    this.load();
  }

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
      if (taskId) this.taskIdToSessionId.set(taskId, sessionId);
      this.scheduleSave();
    }
    return s;
  }

  getSession(sessionId: string): ProtocolSession | undefined {
    return this.sessions.get(sessionId);
  }

  setTaskId(sessionId: string, taskId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      if (s.taskId && s.taskId !== taskId) this.taskIdToSessionId.delete(s.taskId);
      s.taskId = taskId;
      s.updatedAt = Date.now();
      this.taskIdToSessionId.set(taskId, sessionId);
      this.scheduleSave();
    }
  }

  bindTask(sessionId: string, taskId: string): void {
    this.taskIdToSessionId.set(taskId, sessionId);
    this.scheduleSave();
  }

  getSessionByTaskId(taskId: string): ProtocolSession | undefined {
    const sessionId = this.taskIdToSessionId.get(taskId);
    if (sessionId) return this.sessions.get(sessionId);
    return undefined;
  }

  setTitle(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.title = title;
      s.updatedAt = Date.now();
      this.scheduleSave();
    }
  }

  setStatus(sessionId: string, status: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.status = status;
      s.updatedAt = Date.now();
      this.scheduleSave();
    }
  }

  appendEvent(sessionId: string, envelope: ServerEnvelope): void {
    const s = this.ensureSession(sessionId, envelope.sessionId);
    s.updatedAt = Date.now();
    if (!envelope.event.noPersistent) {
      s.events.push(envelope);
      this.scheduleSave();
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
    this.taskIdToSessionId.clear();
    this.save();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 100);
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
      const entries: PersistedSession[] = [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        taskId: s.taskId,
        title: s.title,
        status: s.status,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        events: s.events.filter((e) => !e.event.noPersistent),
      }));
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(entries, null, 2), "utf8");
    } catch {
      /* persistence failures must not break the adapter */
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
      const parsed = JSON.parse(raw) as PersistedSession[];
      if (!Array.isArray(parsed)) return;
      for (const p of parsed) {
        if (!p.sessionId) continue;
        const s: ProtocolSession = {
          sessionId: p.sessionId,
          taskId: p.taskId ?? "",
          title: p.title ?? "New task",
          status: p.status ?? "SESSION_STATUS_CREATED",
          createdAt: p.createdAt ?? Date.now(),
          updatedAt: p.updatedAt ?? Date.now(),
          mapperState: createEventMapperState(),
          events: Array.isArray(p.events) ? p.events.filter((e) => !e.event?.noPersistent) : [],
        };
        this.sessions.set(s.sessionId, s);
        if (s.taskId) this.taskIdToSessionId.set(s.taskId, s.sessionId);
      }
    } catch {
      /* a corrupted cache is not fatal */
    }
  }
}
