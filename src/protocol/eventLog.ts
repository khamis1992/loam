import { database, onDatabaseReset, transaction } from "../server/sqliteStore.js";

/**
 * Durable, append-only event log (BUILD_SPEC §6.1).
 *
 * One `session_events` table holds every event for every session. Sequence
 * numbers are 1-based and gap-free *per session*, allocated inside the write
 * transaction so concurrent writers cannot collide. UPDATE and DELETE are
 * blocked by SQLite triggers: the only way to remove rows is the explicit,
 * audited `purgeSession` used for user-requested permanent deletion.
 */
export type LogKind = "input" | "chat_event" | "tool_result" | "checkpoint" | "status";

export interface LogEvent<P = unknown> {
  sessionId: string;
  seq: number;              // 1-based, gap-free per session
  id: string;               // "evt_<base36>"
  kind: LogKind;
  turnId: string | null;
  idempotencyKey: string | null;
  payload: P;
  createdAt: number;        // epoch ms
}

interface Row {
  session_id: string;
  seq: number;
  id: string;
  kind: LogKind;
  turn_id: string | null;
  idempotency_key: string | null;
  payload: string;
  created_at: number;
}

let ready = false;

function init(): void {
  if (ready) return;
  const db = database();
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('input','chat_event','tool_result','checkpoint','status')),
      turn_id TEXT,
      idempotency_key TEXT,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq),
      UNIQUE (session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS session_events_kind_idx ON session_events(session_id, kind, seq);
    CREATE TRIGGER IF NOT EXISTS session_events_no_update BEFORE UPDATE ON session_events
      BEGIN SELECT RAISE(ABORT, 'session_events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS session_events_no_delete BEFORE DELETE ON session_events
      WHEN (SELECT value FROM metadata WHERE key='eventlog-purge') IS NULL
      BEGIN SELECT RAISE(ABORT, 'session_events are immutable'); END;
  `);
  ready = true;
}

// A reset drops the open connection, so the next database() call opens a fresh
// file: forget the schema flag or the table would never be recreated.
onDatabaseReset(() => {
  ready = false;
});

const newEvtId = (): string =>
  `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Append one event atomically. Same (sessionId, idempotencyKey) returns the existing row (no duplicate). */
export function append<P>(
  sessionId: string,
  kind: LogKind,
  payload: P,
  opts: { turnId?: string; idempotencyKey?: string; id?: string } = {},
): LogEvent<P> {
  init();
  return transaction(() => {
    const db = database();
    if (opts.idempotencyKey) {
      const hit = db
        .prepare("SELECT * FROM session_events WHERE session_id=? AND idempotency_key=?")
        .get(sessionId, opts.idempotencyKey) as Row | undefined;
      if (hit) return fromRow<P>(hit);
    }
    const last = db
      .prepare("SELECT COALESCE(MAX(seq),0) AS s FROM session_events WHERE session_id=?")
      .get(sessionId) as { s: number };
    const ev: LogEvent<P> = {
      sessionId,
      seq: last.s + 1,
      id: opts.id ?? newEvtId(),
      kind,
      turnId: opts.turnId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      payload,
      createdAt: Date.now(),
    };
    db.prepare(
      "INSERT INTO session_events(session_id,seq,id,kind,turn_id,idempotency_key,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      ev.sessionId,
      ev.seq,
      ev.id,
      ev.kind,
      ev.turnId,
      ev.idempotencyKey,
      JSON.stringify(ev.payload),
      ev.createdAt,
    );
    return ev;
  });
}

export function after(sessionId: string, afterSeq = 0, limit = 500): LogEvent[] {
  init();
  const rows = database()
    .prepare("SELECT * FROM session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?")
    .all(sessionId, afterSeq, Math.min(Math.max(limit, 1), 5000)) as unknown as Row[];
  return rows.map((r) => fromRow(r));
}

export function lastOfKind(sessionId: string, kind: LogKind): LogEvent | undefined {
  init();
  const row = database()
    .prepare("SELECT * FROM session_events WHERE session_id=? AND kind=? ORDER BY seq DESC LIMIT 1")
    .get(sessionId, kind) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function headSeq(sessionId: string): number {
  init();
  const row = database()
    .prepare("SELECT COALESCE(MAX(seq),0) AS s FROM session_events WHERE session_id=?")
    .get(sessionId) as { s: number };
  return Number(row.s);
}

export function seqOfId(sessionId: string, id: string): number | undefined {
  init();
  const row = database()
    .prepare("SELECT seq FROM session_events WHERE session_id=? AND id=?")
    .get(sessionId, id) as { seq: number } | undefined;
  return row ? Number(row.seq) : undefined;
}

export function sessionIds(): string[] {
  init();
  const rows = database()
    .prepare("SELECT DISTINCT session_id AS s FROM session_events")
    .all() as unknown as { s: string }[];
  return rows.map((r) => r.s);
}

/** Explicit, audited purge for user-requested permanent deletion only (data controls). */
export function purgeSession(sessionId: string): number {
  init();
  return transaction(() => {
    const db = database();
    db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('eventlog-purge','1')").run();
    const n = Number(db.prepare("DELETE FROM session_events WHERE session_id=?").run(sessionId).changes);
    db.prepare("DELETE FROM metadata WHERE key='eventlog-purge'").run();
    return n;
  });
}

function fromRow<P = unknown>(r: Row): LogEvent<P> {
  return {
    sessionId: r.session_id,
    seq: Number(r.seq),
    id: r.id,
    kind: r.kind,
    turnId: r.turn_id,
    idempotencyKey: r.idempotency_key,
    payload: JSON.parse(r.payload) as P,
    createdAt: Number(r.created_at),
  };
}
