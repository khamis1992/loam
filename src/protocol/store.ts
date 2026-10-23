import { after as afterSeq, append, headSeq, seqOfId, sessionIds as sessionIdsFromLog } from "./eventLog.js";
import { legacySessionsFile, migrateLegacySessions } from "./eventLogMigrate.js";
import { createEventMapperState, type EventMapperState } from "./events.js";
import type { ServerEnvelope } from "./types.js";

/**
 * Protocol store on the durable event log (BUILD_SPEC §6.3).
 *
 * Every frame is appended to `session_events` synchronously, so a crash can never
 * lose an event or leave a half-written file behind; the old debounced whole-file
 * `protocol-sessions.json` write is gone. Session metadata (task id, title, status,
 * creation/update time, soft delete) is folded out of the `status` events on load
 * instead of being copied into a second cache, and any legacy JSON cache is imported
 * once by `migrateLegacySessions` in the constructor.
 */

/** One row of session metadata folded out of the log (BUILD_SPEC §7 `StatusPayload`). */
export interface StatusPayload {
  taskId?: string;
  title?: string;
  status?: string;
  deleted?: boolean;
  createdAt?: number;
}

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

/**
 * Legacy on-disk cache shape. Still read once by `migrateLegacySessions` (O2) and
 * still written by older builds; the current store never writes it.
 */
export interface PersistedSession {
  sessionId: string;
  taskId: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  events: ServerEnvelope[];
  deleted?: boolean;
  deletedAt?: number;
}

const DEFAULT_TITLE = "New task";
const DEFAULT_STATUS = "SESSION_STATUS_CREATED";
/** A run of events replayed at once; `eventsAfter` reads in this-sized pages. */
const REPLAY_PAGE = 5000;

export class ProtocolStore {
  private sessions = new Map<string, ProtocolSession>();
  private taskIdToSessionId = new Map<string, string>();
  private deletedTasks = new Set<string>();

  constructor() {
    // One-time import of the legacy JSON cache before folding the log, so the
    // imported rows take part in the same fold.
    try {
      migrateLegacySessions(legacySessionsFile());
    } catch {
      /* a legacy import failure must not stop the adapter */
    }
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
        status: DEFAULT_STATUS,
        createdAt: now,
        updatedAt: now,
        mapperState: createEventMapperState(),
        events: [],
      };
      this.sessions.set(sessionId, s);
      if (taskId) this.taskIdToSessionId.set(taskId, sessionId);
      this.appendStatus(sessionId, { taskId: taskId || undefined, title, status: DEFAULT_STATUS, createdAt: now });
    }
    return s;
  }

  getSession(sessionId: string): ProtocolSession | undefined {
    return this.sessions.get(sessionId);
  }

  setTaskId(sessionId: string, taskId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.taskId && s.taskId !== taskId) this.taskIdToSessionId.delete(s.taskId);
    s.taskId = taskId;
    s.updatedAt = Date.now();
    if (taskId) this.taskIdToSessionId.set(taskId, sessionId);
    this.appendStatus(sessionId, { taskId });
  }

  bindTask(sessionId: string, taskId: string): void {
    if (this.sessions.get(sessionId)?.taskId === taskId) return;
    this.setTaskId(sessionId, taskId);
  }

  getSessionByTaskId(taskId: string): ProtocolSession | undefined {
    const sessionId = this.taskIdToSessionId.get(taskId);
    if (sessionId) return this.sessions.get(sessionId);
    return undefined;
  }

  setTitle(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.title = title;
    s.updatedAt = Date.now();
    this.appendStatus(sessionId, { title });
  }

  setStatus(sessionId: string, status: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.status = status;
    s.updatedAt = Date.now();
    this.appendStatus(sessionId, { status });
  }

  appendEvent(sessionId: string, envelope: ServerEnvelope): void {
    const s = this.ensureSession(sessionId, envelope.sessionId);
    s.updatedAt = Date.now();
    if (envelope.event.noPersistent) return;
    // Synchronous append: the row is durable before the frame is broadcast.
    const ev = this.appendChat(sessionId, envelope);
    envelope.seq = ev.seq;
    s.events.push(envelope);
  }

  /** Return persisted events with id strictly after lastMessageId. An unknown id
   *  replays everything, exactly as the pre-O3 `findIndex` fallback did. */
  eventsAfter(sessionId: string, lastMessageId?: string): ServerEnvelope[] {
    const after = lastMessageId ? seqOfId(sessionId, lastMessageId) ?? 0 : 0;
    return this.eventsAfterSeq(sessionId, after);
  }

  /** Preferred replay path: every persistent event with `seq > afterSeq` (O4).
   *  Every envelope carries its durable log `seq`, because the payload is a fresh
   *  JSON object after a restart and would otherwise arrive without one — and a
   *  client that cannot see a `seq` can never resume by sequence (§6.4). */
  eventsAfterSeq(sessionId: string, afterSeqValue: number): ServerEnvelope[] {
    return afterSeq(sessionId, Math.max(0, afterSeqValue), REPLAY_PAGE)
      .filter((e) => e.kind === "chat_event")
      .map((e) => {
        const envelope = e.payload as ServerEnvelope;
        return { ...envelope, seq: envelope.seq ?? e.seq };
      });
  }

  listSessions(): ProtocolSession[] {
    return [...this.sessions.values()]
      .filter((s) => !this.deletedTasks.has(s.taskId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  isDeleted(taskId: string): boolean {
    return this.deletedTasks.has(taskId);
  }

  deleteTask(taskId: string): void {
    if (!taskId) return;
    this.deletedTasks.add(taskId);
    const sessionId = this.taskIdToSessionId.get(taskId);
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.status = "SESSION_STATUS_DELETED";
        s.updatedAt = Date.now();
      }
      this.appendStatus(sessionId, { status: "SESSION_STATUS_DELETED", deleted: true });
    }
  }

  undeleteTask(taskId: string): void {
    this.deletedTasks.delete(taskId);
    const sessionId = this.taskIdToSessionId.get(taskId);
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.status = DEFAULT_STATUS;
        s.updatedAt = Date.now();
      }
      this.appendStatus(sessionId, { deleted: false });
    }
  }

  /** Test helper: drop all in-memory state. The durable log is untouched, so a new
   *  instance (or `resetDb()`) decides what comes back. */
  clear(): void {
    this.sessions.clear();
    this.taskIdToSessionId.clear();
    this.deletedTasks.clear();
  }

  /** Append one frame to the log. The envelope id doubles as the log row id so
   *  `seqOfId` can resolve a replay cursor; a globally reused id falls back to a
   *  log-generated one (the payload keeps the envelope id). */
  private appendChat(sessionId: string, envelope: ServerEnvelope) {
    try {
      return append(sessionId, "chat_event", envelope, { id: envelope.id, idempotencyKey: envelope.id });
    } catch {
      return append(sessionId, "chat_event", envelope, { idempotencyKey: envelope.id });
    }
  }

  /** Append a `status` row carrying session metadata. The in-memory cache is
   *  updated here too, so live callers see it immediately; on the next load the
   *  same row rebuilds the identical state. */
  private appendStatus(sessionId: string, payload: StatusPayload): void {
    append(sessionId, "status", payload, { idempotencyKey: `status:${headSeq(sessionId)}` });
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (typeof payload.title === "string") s.title = payload.title;
    if (typeof payload.status === "string") s.status = payload.status;
    if (typeof payload.createdAt === "number") s.createdAt = payload.createdAt;
    if (typeof payload.taskId === "string" && payload.taskId) s.taskId = payload.taskId;
    s.updatedAt = Date.now();
  }

  /** Rebuild the session cache by folding the `status` events of every session. */
  private load(): void {
    this.sessions.clear();
    this.taskIdToSessionId.clear();
    this.deletedTasks.clear();
    for (const sessionId of sessionIdsFromLog()) {
      const s: ProtocolSession = {
        sessionId,
        taskId: "",
        title: DEFAULT_TITLE,
        status: DEFAULT_STATUS,
        createdAt: 0,
        updatedAt: 0,
        mapperState: createEventMapperState(),
        events: [],
      };
      let deleted = false;
      for (const ev of afterSeq(sessionId)) {
        s.updatedAt = Math.max(s.updatedAt, ev.createdAt);
        if (s.createdAt === 0) s.createdAt = ev.createdAt;
        if (ev.kind !== "status") continue;
        const p = ev.payload as Partial<StatusPayload>;
        if (typeof p.title === "string") s.title = p.title;
        if (typeof p.status === "string") s.status = p.status;
        if (typeof p.createdAt === "number") s.createdAt = p.createdAt;
        if (typeof p.taskId === "string" && p.taskId) s.taskId = p.taskId;
        if (typeof p.deleted === "boolean") deleted = p.deleted;
      }
      if (s.createdAt === 0) s.createdAt = Date.now();
      if (s.updatedAt === 0) s.updatedAt = s.createdAt;
      this.sessions.set(sessionId, s);
      if (s.taskId) {
        this.taskIdToSessionId.set(s.taskId, sessionId);
        if (deleted) this.deletedTasks.add(s.taskId);
      }
    }
  }
}
