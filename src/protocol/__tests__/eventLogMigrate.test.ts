/**
 * Tests for the one-time legacy session import (BUILD_SPEC §6.2, plan row O2).
 *
 * `LOAM_DATA_DIR` points at a throwaway temp dir before the modules are
 * imported, so the real app `data/` folder is never touched. The fixture file
 * holds 2 sessions with 5 persistent events in total; the import must produce
 * 2 `status` rows + 5 `chat_event` rows = 7 rows, be a no-op on a second run,
 * and leave a `.pre-eventlog.bak` copy next to the original.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-eventlog-migrate-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import { closeDb, database, resetDb } from "../../server/sqliteStore.js";
import { after as afterSeq, append, headSeq, purgeSession } from "../eventLog.js";
import {
  LEGACY_BACKUP_SUFFIX,
  LEGACY_IMPORT_KEY,
  importLegacySession,
  legacySessionsFile,
  migrateLegacySessions,
} from "../eventLogMigrate.js";
import type { PersistedSession } from "../store.js";
import type { ServerEnvelope } from "../types.js";

const FILE = path.join(tmpDir, "protocol-sessions.json");

function envelope(id: string, sessionId: string, content: string, extra: Partial<ServerEnvelope> = {}): ServerEnvelope {
  return {
    id,
    type: "event",
    sessionId,
    timestamp: 1_700_000_000_000,
    event: { id, type: "chat", timestamp: 1_700_000_000_000, sender: "assistant", messageType: "text", content, attachments: [] },
    ...extra,
  };
}

function writeFixture(sessions: PersistedSession[]): void {
  fs.writeFileSync(FILE, JSON.stringify(sessions, null, 2), "utf8");
}

function rowCount(sessionId: string): number {
  return afterSeq(sessionId).length;
}

describe("eventLogMigrate", () => {
  before(() => {
    resetDb();
  });

  it("imports 2 sessions and 5 events as 7 rows", () => {
    writeFixture([
      {
        sessionId: "ses_import_a",
        taskId: "task_a",
        title: "اختبار",
        status: "SESSION_STATUS_RUNNING",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
        events: [
          envelope("evt_a1", "ses_import_a", "مرحبا"),
          envelope("evt_a2", "ses_import_a", "hello"),
        ],
      },
      {
        sessionId: "ses_import_b",
        taskId: "task_b",
        title: "Second",
        status: "SESSION_STATUS_CREATED",
        createdAt: 1_700_000_001_000,
        updatedAt: 1_700_000_001_500,
        events: [
          envelope("evt_b1", "ses_import_b", "one"),
          envelope("evt_b2", "ses_import_b", "two"),
          envelope("evt_b3", "ses_import_b", "three"),
        ],
      },
    ]);

    const result = migrateLegacySessions(FILE);
    assert.deepEqual(result, { sessions: 2, events: 7, skipped: [] });

    // 2 status rows + 5 chat_event rows, in order, with no sequence gaps.
    assert.equal(rowCount("ses_import_a"), 3);
    assert.equal(rowCount("ses_import_b"), 4);
    assert.equal(headSeq("ses_import_a"), 3);
    assert.equal(headSeq("ses_import_b"), 4);

    const a = afterSeq("ses_import_a");
    assert.deepEqual(a.map((e) => e.seq), [1, 2, 3]);
    assert.equal(a[0]!.kind, "status");
    assert.deepEqual(a[0]!.payload, {
      taskId: "task_a",
      title: "اختبار",
      status: "SESSION_STATUS_RUNNING",
      createdAt: 1_700_000_000_000,
      deleted: false,
    });
    assert.equal(a[1]!.kind, "chat_event");
    assert.equal((a[1]!.payload as ServerEnvelope).id, "evt_a1");
    assert.equal(a[1]!.id, "evt_a1");
    assert.equal(a[1]!.idempotencyKey, "legacy:evt_a1");
    const lastChat = a[2]!.payload as ServerEnvelope;
    assert.equal(lastChat.event.type, "chat");
    assert.equal((lastChat.event as { content: string }).content, "hello");

    const b = afterSeq("ses_import_b");
    assert.equal(b[0]!.kind, "status");
    assert.equal(b[0]!.idempotencyKey, "legacy:meta");
    assert.deepEqual(b.slice(1).map((e) => (e.payload as ServerEnvelope).id), ["evt_b1", "evt_b2", "evt_b3"]);
  });

  it("is a no-op on a second run (imports 0 rows)", () => {
    const before = rowCount("ses_import_a") + rowCount("ses_import_b");
    const second = migrateLegacySessions(FILE);
    assert.deepEqual(second, { sessions: 0, events: 0, skipped: [] });
    assert.equal(rowCount("ses_import_a") + rowCount("ses_import_b"), before);
    // The one-shot marker is set, so a second run never re-reads the file.
    assert.ok(getMetaSet());
  });

  it("leaves a .pre-eventlog.bak copy of the original file", () => {
    const backup = FILE + LEGACY_BACKUP_SUFFIX;
    assert.ok(fs.existsSync(backup), "backup file should exist");
    const original = JSON.parse(fs.readFileSync(FILE, "utf8")) as PersistedSession[];
    const copied = JSON.parse(fs.readFileSync(backup, "utf8")) as PersistedSession[];
    assert.deepEqual(copied, original);
    assert.equal(copied.length, 2);
  });

  it("does nothing when the legacy file is missing", () => {
    const missing = path.join(tmpDir, "nope", "protocol-sessions.json");
    assert.deepEqual(migrateLegacySessions(missing), { sessions: 0, events: 0, skipped: [] });
    assert.equal(fs.existsSync(missing + LEGACY_BACKUP_SUFFIX), false);
  });

  it("skips sessions that already have rows and skips noPersistent events", () => {
    // A session already present in the log must not be imported twice.
    append("ses_existing", "status", { taskId: "task_existing", title: "Existing", status: "SESSION_STATUS_RUNNING" });
    writeFixture([
      {
        sessionId: "ses_existing",
        taskId: "task_existing",
        title: "Existing",
        status: "SESSION_STATUS_RUNNING",
        createdAt: 1,
        updatedAt: 2,
        events: [envelope("evt_x1", "ses_existing", "old")],
      },
      {
        sessionId: "ses_fresh",
        taskId: "task_fresh",
        title: "Fresh",
        status: "SESSION_STATUS_CREATED",
        createdAt: 3,
        updatedAt: 4,
        events: [
          envelope("evt_f1", "ses_fresh", "kept"),
          envelope("evt_f2", "ses_fresh", "dropped", { event: { ...envelope("evt_f2", "ses_fresh", "dropped").event, noPersistent: true } }),
        ],
      },
    ]);

    // Clear the one-shot marker so the fixture is read again.
    database().prepare("DELETE FROM metadata WHERE key=?").run(LEGACY_IMPORT_KEY);
    const result = migrateLegacySessions(FILE);
    assert.deepEqual(result.skipped, ["ses_existing"]);
    assert.equal(result.sessions, 2);
    assert.equal(result.events, 2); // 1 status + 1 persistent chat_event for ses_fresh
    assert.equal(rowCount("ses_existing"), 1);
    assert.equal(rowCount("ses_fresh"), 2);
    const fresh = afterSeq("ses_fresh");
    assert.equal(fresh[0]!.kind, "status");
    assert.equal((fresh[1]!.payload as ServerEnvelope).id, "evt_f1");
  });

  it("importLegacySession refuses to touch a session that already has rows", () => {
    assert.equal(importLegacySession({
      sessionId: "ses_import_a",
      taskId: "task_a",
      title: "again",
      status: "SESSION_STATUS_RUNNING",
      createdAt: 1,
      updatedAt: 2,
      events: [envelope("evt_again", "ses_import_a", "again")],
    }), 0);
    assert.equal(rowCount("ses_import_a"), 3);
  });

  it("legacySessionsFile resolves inside the configured data dir", () => {
    assert.equal(legacySessionsFile(), path.join(tmpDir, "protocol-sessions.json"));
  });

  it("survives a restart: the imported rows are durable", () => {
    closeDb();
    resetDb();
    assert.equal(headSeq("ses_import_a"), 3);
    assert.equal((afterSeq("ses_import_a")[1]!.payload as ServerEnvelope).id, "evt_a1");
    // The metadata marker is durable too, so a restart does not re-import.
    assert.deepEqual(migrateLegacySessions(FILE), { sessions: 0, events: 0, skipped: [] });
    purgeSession("ses_import_a");
    purgeSession("ses_import_b");
    purgeSession("ses_fresh");
    assert.equal(headSeq("ses_import_a"), 0);
  });
});

function getMetaSet(): boolean {
  const row = database().prepare("SELECT value FROM metadata WHERE key='eventlog-legacy-import'").get() as { value: string } | undefined;
  return typeof row?.value === "string" && row.value.length > 0;
}
