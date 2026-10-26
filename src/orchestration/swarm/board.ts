/**
 * C11: the coordination substrate of one coding-team run. One SQLite file per run
 * (`<runRoot>/.loam/realswarm/coord.sqlite`, never manus.db) holds the append-only
 * board, the mailbox, per-worker delivery cursors and the durable event queue.
 * Driver: node:sqlite DatabaseSync, the driver Loam already uses (sqliteStore.ts),
 * with the same pragmas (sqliteStore.ts WAL/FULL/busy_timeout).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type BoardEntry, type BoardNote, type BoardNoteType, type BoardWriteResult, type MailboxMessage,
  type RealSwarmMetrics, type SwarmEvent, type SwarmEventKind, type SwarmEventState,
  DEFAULT_CLAIM_TTL_SECONDS, MAX_ATTEMPTS, MAX_DETAIL_CHARS, RETRY_BACKOFF_MS,
} from "./types.js";
import { admit, findOverlappingClaim, isExpiredClaim, isOpenClaim, normalizeWorkLabel, renderBoard, verifyNote } from "./admission.js";

export const COORD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS board_gists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('FACT','OBSERVED','FAIL','CLAIM','PATCH_SUMMARY')),
  content    TEXT NOT NULL,
  work_label TEXT,
  detail     TEXT,
  ts         REAL NOT NULL,
  expires_at REAL
);
CREATE INDEX IF NOT EXISTS ix_board_type ON board_gists(type);
CREATE INDEX IF NOT EXISTS ix_board_label ON board_gists(work_label);
CREATE TABLE IF NOT EXISTS mailbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_worker TEXT NOT NULL,
  to_worker   TEXT,
  body        TEXT NOT NULL,
  ts          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mailbox_to ON mailbox(to_worker, id);
CREATE TABLE IF NOT EXISTS cursors (
  worker        TEXT PRIMARY KEY,
  board_gist_id INTEGER NOT NULL DEFAULT 0,
  channel_id    INTEGER NOT NULL DEFAULT 0,
  dm_id         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  worker        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('turn','idle_nudge','forced_write','merge_conflict')),
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  next_retry_at INTEGER,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_worker_state ON events(worker, state, id);
`;

interface GistRow { id: number; thread_id: string; type: string; content: string; work_label: string | null; detail: string | null; ts: number; expires_at: number | null }
interface MailRow { id: number; from_worker: string; to_worker: string | null; body: string; ts: number }
interface EventRow { id: number; worker: string; kind: string; payload: string; state: string; attempts: number; created_at: number; next_retry_at: number | null; last_error: string | null }

export function coordinationDbPath(runRoot: string): string {
  return path.join(runRoot, ".loam", "realswarm", "coord.sqlite");
}

/** Boolean board query: "a&b|c" = (a AND b) OR c, case-insensitive substring over content, label and detail. */
export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = text.toLowerCase();
  return q.split("|").some((group) => group.split("&").map((w) => w.trim()).filter(Boolean).every((w) => hay.includes(w)));
}

export class CoordinationDb {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(
    readonly dbPath: string,
    private readonly nowSec: () => number = () => Date.now() / 1000,
    /** Internal seam: tests shorten the backoff; production always uses RETRY_BACKOFF_MS. */
    private readonly backoffMs: readonly number[] = RETRY_BACKOFF_MS,
  ) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(COORD_SCHEMA_SQL);
  }

  journalMode(): string {
    return String((this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  }

  /* ------------------------------------------------------------------ board */

  private rows(): GistRow[] {
    return this.db.prepare("SELECT id, thread_id, type, content, work_label, detail, ts, expires_at FROM board_gists ORDER BY id").all() as unknown as GistRow[];
  }

  private toEntry(r: GistRow): BoardEntry {
    return {
      id: r.id, label: `G${r.id}`, thread_id: r.thread_id, type: r.type as BoardNoteType, content: r.content,
      ...(r.work_label ? { work_label: r.work_label } : {}), ts: r.ts, expires_at: r.expires_at, has_detail: !!r.detail,
    };
  }

  /** Derived live entries: every stored row replayed through admit() (rows themselves are never edited). */
  entries(): BoardEntry[] {
    const out: BoardEntry[] = [];
    for (const r of this.rows()) admit(out, this.toEntry(r));
    return out;
  }

  boardWrite(note: BoardNote): BoardWriteResult {
    const v = verifyNote({ type: String(note.type), content: note.content });
    if (!v.clean) return { status: "rejected", reason: v.reason };
    const now = this.nowSec();
    const label = normalizeWorkLabel(note.work_label) || null;
    let overlap: BoardWriteResult["overlap"];
    if (v.clean.type === "CLAIM") {
      const hit = findOverlappingClaim(this.entries(), { thread_id: note.thread_id, work_label: label ?? undefined, content: v.clean.content }, now);
      if (hit) overlap = { label: hit.label, holder: hit.thread_id, ...(hit.work_label ? { work_label: hit.work_label } : {}) };
    }
    const ttl = Math.max(1, Math.floor(note.ttl_seconds ?? DEFAULT_CLAIM_TTL_SECONDS));
    const res = this.db
      .prepare("INSERT INTO board_gists (thread_id, type, content, work_label, detail, ts, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(note.thread_id, v.clean.type, v.clean.content, label, note.detail ? String(note.detail).slice(0, MAX_DETAIL_CHARS) : null, now, v.clean.type === "CLAIM" ? now + ttl : null);
    const id = Number(res.lastInsertRowid);
    return { status: "admitted", reason: v.reason, gist_id: id, label: `G${id}`, ...(overlap ? { overlap } : {}) };
  }

  boardRead(): { rendered: string; entries: BoardEntry[] } {
    const entries = this.entries();
    return { rendered: renderBoard(entries, this.nowSec()), entries };
  }

  /** Full persisted history, expired claims included. */
  boardGrep(words = "", types = "", limit = 100): BoardEntry[] {
    const want = new Set(types.split(/[,\s|]+/).map((t) => t.trim().toUpperCase()).filter(Boolean));
    const lim = Math.max(1, Math.min(500, Math.floor(limit)));
    const hits = this.rows().filter((r) => (!want.size || want.has(r.type)) && matchesQuery(`${r.content}\n${r.work_label ?? ""}\n${r.detail ?? ""}`, words));
    return hits.slice(-lim).map((r) => this.toEntry(r));
  }

  boardUnfold(labels: string[]): Array<{ label: string; detail: string | null }> {
    const stmt = this.db.prepare("SELECT detail FROM board_gists WHERE id = ?");
    return labels.slice(0, 20).map((l) => {
      const id = Number(String(l).replace(/^G/i, ""));
      const row = Number.isInteger(id) && id > 0 ? (stmt.get(id) as { detail: string | null } | undefined) : undefined;
      return { label: `G${id}`, detail: row?.detail ?? null };
    });
  }

  /** Newest open CLAIM work label of a worker (shown in the UI as its current work). */
  currentClaim(worker: string): string | undefined {
    const now = this.nowSec();
    const open = this.entries().filter((e) => e.thread_id === worker && isOpenClaim(e, now));
    return open[open.length - 1]?.work_label;
  }

  openClaimCount(): number {
    const now = this.nowSec();
    return this.entries().filter((e) => isOpenClaim(e, now)).length;
  }

  verifiedPatchCount(): number {
    return this.entries().filter((e) => e.type === "PATCH_SUMMARY" && e.verified_checkpoint && !e.invalidated_by_fail).length;
  }

  /** Latest verified, not invalidated PATCH_SUMMARY per author for one work label. */
  verifiedPatchesFor(workLabel: string): BoardEntry[] {
    const label = normalizeWorkLabel(workLabel);
    return this.entries().filter((e) => e.type === "PATCH_SUMMARY" && e.work_label === label && e.verified_checkpoint && !e.invalidated_by_fail);
  }

  maxGistId(): number {
    return Number((this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM board_gists").get() as { m: number }).m);
  }

  lastGistTs(worker: string): number | undefined {
    const r = this.db.prepare("SELECT MAX(ts) AS t FROM board_gists WHERE thread_id = ?").get(worker) as { t: number | null };
    return r.t ?? undefined;
  }

  gistCountBy(worker: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM board_gists WHERE thread_id = ?").get(worker) as { n: number }).n);
  }

  /* ---------------------------------------------------------------- mailbox */

  private cursor(worker: string): { board_gist_id: number; channel_id: number; dm_id: number } {
    this.db.prepare("INSERT OR IGNORE INTO cursors (worker) VALUES (?)").run(worker);
    return this.db.prepare("SELECT board_gist_id, channel_id, dm_id FROM cursors WHERE worker = ?").get(worker) as { board_gist_id: number; channel_id: number; dm_id: number };
  }

  sendMessage(m: { from: string; to?: string | null; body: string }): MailboxMessage {
    const body = String(m.body ?? "").trim().slice(0, 2000);
    if (!body) throw new Error("empty message");
    const ts = this.nowSec();
    const to = m.to ? String(m.to) : null;
    const r = this.db.prepare("INSERT INTO mailbox (from_worker, to_worker, body, ts) VALUES (?, ?, ?, ?)").run(m.from, to, body, ts);
    return { id: Number(r.lastInsertRowid), from: m.from, to, body, ts };
  }

  private mail(r: MailRow): MailboxMessage {
    return { id: r.id, from: r.from_worker, to: r.to_worker, body: r.body, ts: r.ts };
  }

  /** Turn-start tier: team-channel messages from others since the worker's channel cursor. */
  drainChannel(worker: string): MailboxMessage[] {
    const c = this.cursor(worker);
    const rows = this.db.prepare("SELECT * FROM mailbox WHERE to_worker IS NULL AND id > ? AND from_worker <> ? ORDER BY id").all(c.channel_id, worker) as unknown as MailRow[];
    if (rows.length) this.db.prepare("UPDATE cursors SET channel_id = ? WHERE worker = ?").run(rows[rows.length - 1]!.id, worker);
    return rows.map((r) => this.mail(r));
  }

  /** Mid-turn tier: direct messages to the worker since its DM cursor. */
  drainDirect(worker: string): MailboxMessage[] {
    const c = this.cursor(worker);
    const rows = this.db.prepare("SELECT * FROM mailbox WHERE to_worker = ? AND id > ? ORDER BY id").all(worker, c.dm_id) as unknown as MailRow[];
    if (rows.length) this.db.prepare("UPDATE cursors SET dm_id = ? WHERE worker = ?").run(rows[rows.length - 1]!.id, worker);
    return rows.map((r) => this.mail(r));
  }

  /** Peer gists the worker has not seen yet (advances its board cursor). */
  drainNewGists(worker: string): BoardEntry[] {
    const c = this.cursor(worker);
    const rows = this.db.prepare("SELECT id, thread_id, type, content, work_label, detail, ts, expires_at FROM board_gists WHERE id > ? ORDER BY id").all(c.board_gist_id) as unknown as GistRow[];
    if (rows.length) this.db.prepare("UPDATE cursors SET board_gist_id = ? WHERE worker = ?").run(rows[rows.length - 1]!.id, worker);
    return rows.filter((r) => r.thread_id !== worker).map((r) => this.toEntry(r));
  }

  /** Marks the whole board as seen (used after a turn-start snapshot). */
  markBoardSeen(worker: string): void {
    this.cursor(worker);
    this.db.prepare("UPDATE cursors SET board_gist_id = ? WHERE worker = ?").run(this.maxGistId(), worker);
  }

  /** True when something an idle worker should react to arrived: a peer PATCH_SUMMARY or FAIL, or any message. */
  hasWakeSignal(worker: string): boolean {
    const c = this.cursor(worker);
    const g = this.db.prepare("SELECT COUNT(*) AS n FROM board_gists WHERE id > ? AND thread_id <> ? AND type IN ('PATCH_SUMMARY','FAIL')").get(c.board_gist_id, worker) as { n: number };
    const m = this.db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE ((to_worker = ? AND id > ?) OR (to_worker IS NULL AND id > ? AND from_worker <> ?))").get(worker, c.dm_id, c.channel_id, worker) as { n: number };
    return Number(g.n) + Number(m.n) > 0;
  }

  /* ------------------------------------------------------------ event queue */

  private event(r: EventRow): SwarmEvent {
    return { id: r.id, worker: r.worker, kind: r.kind as SwarmEventKind, payload: JSON.parse(r.payload) as Record<string, unknown>, state: r.state as SwarmEventState, attempts: r.attempts, created_at: r.created_at, next_retry_at: r.next_retry_at, last_error: r.last_error };
  }

  enqueue(worker: string, kind: SwarmEventKind, payload: Record<string, unknown> = {}, nowMs = Date.now()): SwarmEvent {
    const r = this.db.prepare("INSERT INTO events (worker, kind, payload, created_at) VALUES (?, ?, ?, ?)").run(worker, kind, JSON.stringify(payload), nowMs);
    return this.event(this.db.prepare("SELECT * FROM events WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as EventRow);
  }

  hasPending(worker: string, kind: SwarmEventKind): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE worker = ? AND kind = ? AND state IN ('pending','sending') LIMIT 1").get(worker, kind);
  }

  /** Drops a worker's not-yet-started events of one kind (e.g. a merge_conflict note after the merge landed). */
  supersede(worker: string, kind: SwarmEventKind): number {
    return Number(this.db.prepare("UPDATE events SET state = 'sent', last_error = 'superseded' WHERE worker = ? AND kind = ? AND state = 'pending'").run(worker, kind).changes);
  }

  /** The oldest pending event of a worker that is due now, or how long to wait for the next one. */
  nextEventFor(worker: string, nowMs = Date.now()): { due?: SwarmEvent; waitMs?: number } {
    const rows = this.db.prepare("SELECT * FROM events WHERE worker = ? AND state = 'pending' ORDER BY id").all(worker) as unknown as EventRow[];
    let wait: number | undefined;
    for (const r of rows) {
      if (r.next_retry_at === null || r.next_retry_at <= nowMs) return { due: this.event(r) };
      wait = Math.min(wait ?? Infinity, r.next_retry_at - nowMs);
    }
    return wait === undefined ? {} : { waitMs: wait };
  }

  markSending(id: number): void {
    this.db.prepare("UPDATE events SET state = 'sending' WHERE id = ? AND state = 'pending'").run(id);
  }

  markSent(id: number): void {
    this.db.prepare("UPDATE events SET state = 'sent', last_error = NULL WHERE id = ?").run(id);
  }

  /** Bounded retry: back to pending with backoff [1s,5s,30s,120s], or failed after MAX_ATTEMPTS. */
  markFailed(id: number, error: string, nowMs = Date.now()): SwarmEventState {
    const r = this.db.prepare("SELECT attempts FROM events WHERE id = ?").get(id) as { attempts: number } | undefined;
    if (!r) return "failed";
    const attempts = r.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.db.prepare("UPDATE events SET state = 'failed', attempts = ?, last_error = ?, next_retry_at = NULL WHERE id = ?").run(attempts, error.slice(0, 500), id);
      return "failed";
    }
    const delay = this.backoffMs[Math.min(attempts - 1, this.backoffMs.length - 1)] ?? 0;
    this.db.prepare("UPDATE events SET state = 'pending', attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?").run(attempts, error.slice(0, 500), nowMs + delay, id);
    return "pending";
  }

  /** After a restart: events left in 'sending' go back to the queue. */
  requeueInterrupted(): number {
    return Number(this.db.prepare("UPDATE events SET state = 'pending' WHERE state = 'sending'").run().changes);
  }

  eventsFor(worker: string): SwarmEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE worker = ? ORDER BY id").all(worker) as unknown as EventRow[]).map((r) => this.event(r));
  }

  /* ---------------------------------------------------------------- metrics */

  /** Board-derived counters (git-derived counters are filled by the service). */
  boardMetrics(): Pick<RealSwarmMetrics, "claimsOpened" | "claimsActive" | "claimsExpired" | "patchSummaries" | "patchVerified" | "patchInvalidated" | "failsRecorded" | "factsRecorded" | "messagesChannel" | "messagesDirect"> {
    const now = this.nowSec();
    const rows = this.rows();
    const live = this.entries();
    const count = (t: string) => rows.filter((r) => r.type === t).length;
    const m = this.db.prepare("SELECT SUM(CASE WHEN to_worker IS NULL THEN 1 ELSE 0 END) AS ch, SUM(CASE WHEN to_worker IS NOT NULL THEN 1 ELSE 0 END) AS dm FROM mailbox").get() as { ch: number | null; dm: number | null };
    return {
      claimsOpened: count("CLAIM"),
      claimsActive: live.filter((e) => isOpenClaim(e, now)).length,
      claimsExpired: live.filter((e) => isExpiredClaim(e, now)).length,
      patchSummaries: count("PATCH_SUMMARY"),
      patchVerified: live.filter((e) => e.type === "PATCH_SUMMARY" && e.verified_checkpoint && !e.invalidated_by_fail).length,
      patchInvalidated: live.filter((e) => e.type === "PATCH_SUMMARY" && !!e.invalidated_by_fail).length,
      failsRecorded: count("FAIL"),
      factsRecorded: count("FACT"),
      messagesChannel: Number(m.ch ?? 0),
      messagesDirect: Number(m.dm ?? 0),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
