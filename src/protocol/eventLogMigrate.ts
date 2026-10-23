import fs from "node:fs";
import path from "node:path";
import { append, headSeq } from "./eventLog.js";
import { getMeta, setMeta } from "../server/sqliteStore.js";
import type { PersistedSession } from "./store.js";
import type { ServerEnvelope } from "./types.js";

/**
 * One-time import of the legacy `protocol-sessions.json` cache into the durable
 * append-only event log (BUILD_SPEC §6.2).
 *
 * Before O3 the protocol store kept every session event in one debounced JSON
 * file, so a crash could lose up to 100 ms of history or leave a half-written
 * file behind. This function moves that history into `session_events` once and
 * then leaves a `.pre-eventlog.bak` copy next to the original, so the store can
 * stop writing the JSON file without losing what already existed.
 *
 * The import is guarded by the `eventlog-legacy-import` metadata row, so a
 * second call is a no-op even if the backup file already exists. Sessions that
 * already have rows in the log are skipped, which makes the import safe to run
 * after a partial failure.
 */

export const LEGACY_IMPORT_KEY = "eventlog-legacy-import";
export const LEGACY_BACKUP_SUFFIX = ".pre-eventlog.bak";

export interface LegacyImportResult {
  /** Sessions read from the legacy file (including ones skipped as already imported). */
  sessions: number;
  /** `status` + `chat_event` rows actually appended. */
  events: number;
  /** Session ids that already had rows in the log and were therefore skipped. */
  skipped: string[];
}

function isEnvelope(value: unknown): value is ServerEnvelope {
  return Boolean(value) && typeof value === "object" && typeof (value as ServerEnvelope).id === "string"
    && typeof (value as ServerEnvelope).sessionId === "string";
}

/**
 * Append one legacy session to the log. Returns the number of rows written
 * (one `status` row plus one `chat_event` row per persistent envelope).
 */
export function importLegacySession(session: PersistedSession): number {
  if (!session.sessionId || headSeq(session.sessionId) > 0) return 0;
  let written = 0;
  append(
    session.sessionId,
    "status",
    {
      taskId: session.taskId,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      deleted: !!session.deleted,
    },
    { idempotencyKey: "legacy:meta" },
  );
  written += 1;
  for (const envelope of Array.isArray(session.events) ? session.events : []) {
    // `noPersistent` events were never written to the JSON file either, so the
    // log must not gain rows the old store deliberately dropped.
    if (!isEnvelope(envelope) || envelope.event?.noPersistent) continue;
    append(session.sessionId, "chat_event", envelope, {
      // Only forward ids the log's UNIQUE constraint can guarantee; a legacy
      // file may contain two sessions that share an event id.
      id: envelope.id.startsWith("evt_") ? envelope.id : undefined,
      idempotencyKey: `legacy:${envelope.id}`,
    });
    written += 1;
  }
  return written;
}

/** Import every session from a legacy `protocol-sessions.json` file. Idempotent. */
export function migrateLegacySessions(file: string): LegacyImportResult {
  if (getMeta(LEGACY_IMPORT_KEY) || !fs.existsSync(file)) return { sessions: 0, events: 0, skipped: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedSession[];
  const list = Array.isArray(parsed) ? parsed : [];
  let events = 0;
  const skipped: string[] = [];
  for (const session of list) {
    if (!session?.sessionId) continue;
    if (headSeq(session.sessionId) > 0) {
      skipped.push(session.sessionId);
      continue;
    }
    events += importLegacySession(session);
  }
  // Keep the original file readable for support/diagnostics, but make the copy
  // first so a crash mid-import never destroys the only copy of the history.
  const backup = file + LEGACY_BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  setMeta(LEGACY_IMPORT_KEY, new Date().toISOString());
  return { sessions: list.length, events, skipped };
}

/** Default location of the legacy cache, matching `ProtocolStore`'s data dir. */
export function legacySessionsFile(): string {
  const dir = process.env.LOAM_DATA_DIR || process.env.MANUS_LOCAL_DATA_DIR;
  return path.join(dir ? dir.replace(/[\\/]+$/, "") : "data", "protocol-sessions.json");
}
