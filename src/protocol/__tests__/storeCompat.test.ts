/**
 * Tests for the protocol store on the durable event log (BUILD_SPEC §6.3, plan row O3).
 *
 * `LOAM_DATA_DIR` points at a throwaway temp dir before the modules are imported, so
 * the real app `data/` folder is never touched. A restart is simulated by closing the
 * SQLite connection and constructing a new `ProtocolStore`; the test then asserts the
 * sessions, titles, events and soft-deletes come back identically, and that no
 * `protocol-sessions.json` is written after the one-time legacy import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-store-compat-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import { closeDb, database, resetDb } from "../../server/sqliteStore.js";
import { after as afterSeq, headSeq, purgeSession, seqOfId } from "../eventLog.js";
import { LEGACY_BACKUP_SUFFIX, LEGACY_IMPORT_KEY } from "../eventLogMigrate.js";
import { ProtocolStore } from "../store.js";
import type { PersistedSession } from "../store.js";
import type { ServerEnvelope } from "../types.js";

const LEGACY_FILE = path.join(tmpDir, "protocol-sessions.json");

function envelope(id: string, sessionId: string, content: string): ServerEnvelope {
  return {
    id,
    type: "event",
    sessionId,
    timestamp: 1_700_000_000_000,
    event: { id, type: "chat", timestamp: 1_700_000_000_000, sender: "assistant", messageType: "text", content, attachments: [] },
  };
}

/**
 * A legacy `protocol-sessions.json` written *before* the store module is imported,
 * so the very first `new ProtocolStore()` performs the one-time import. The file is
 * left exactly as written: the store must never rewrite it.
 */
fs.writeFileSync(
  LEGACY_FILE,
  JSON.stringify(
    [
      {
        sessionId: "ses_legacy_a",
        taskId: "task_a",
        title: "اختبار",
        status: "SESSION_STATUS_RUNNING",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
        events: [envelope("evt_a1", "ses_legacy_a", "مرحبا"), envelope("evt_a2", "ses_legacy_a", "hello")],
      },
      {
        sessionId: "ses_legacy_b",
        taskId: "task_b",
        title: "Second",
        status: "SESSION_STATUS_CREATED",
        createdAt: 1_700_000_001_000,
        updatedAt: 1_700_000_001_500,
        events: [envelope("evt_b1", "ses_legacy_b", "one")],
      },
    ] satisfies PersistedSession[],
    null,
    2,
  ),
  "utf8",
);
// Bytes of the fixture exactly as written: the store must never rewrite it.
const LEGACY_RAW_BEFORE = fs.readFileSync(LEGACY_FILE, "utf8");

function restart(): void {
  closeDb();
  resetDb();
}

/** The persisted view of a store: sessions, titles, statuses and event ids. */
function snapshot(store: ProtocolStore): Record<string, unknown> {
  return {
    sessions: store.listSessions().map((s) => ({
      sessionId: s.sessionId,
      taskId: s.taskId,
      title: s.title,
      status: s.status,
      // The durable view: what a restart will replay, not the in-memory cache.
      events: store.eventsAfter(s.sessionId).map((e) => e.id),
    })),
    byTask: store.listSessions().map((s) => [s.taskId, s.sessionId]),
  };
}

describe("ProtocolStore on the event log", () => {
  before(() => {
    restart();
  });

  it("writes every frame through eventLog.append and stamps the envelope seq", () => {
    const store = new ProtocolStore();
    const s = store.ensureSession("ses_seq", "task_seq", "Title");
    const frames = [envelope("evt_1", "ses_seq", "one"), envelope("evt_2", "ses_seq", "two"), envelope("evt_3", "ses_seq", "three")];
    for (const f of frames) store.appendEvent("ses_seq", f);

    assert.deepEqual(frames.map((f) => f.seq), [2, 3, 4]); // seq 1 is the status row
    assert.equal(headSeq("ses_seq"), 4);
    assert.deepEqual(store.eventsAfter("ses_seq").map((e) => e.id), ["evt_1", "evt_2", "evt_3"]);
    assert.equal(seqOfId("ses_seq", "evt_1"), 2);
    assert.equal(s.events.length, 3);
  });

  it("survives a restart: same sessions, titles, statuses and events", () => {
    const store = new ProtocolStore();
    store.ensureSession("ses_restart", "task_restart", "أول مهمة");
    store.setTitle("ses_restart", "عنوان محدّث");
    store.appendEvent("ses_restart", envelope("evt_r1", "ses_restart", "مرحبا"));
    store.appendEvent("ses_restart", envelope("evt_r2", "ses_restart", "hello"));
    store.setStatus("ses_restart", "SESSION_STATUS_STOPPED");

    const beforeSnap = snapshot(store);

    restart();
    const store2 = new ProtocolStore();

    assert.deepEqual(snapshot(store2), beforeSnap);
    const s = store2.getSession("ses_restart");
    assert.ok(s, "session should survive a restart");
    assert.equal(s!.title, "عنوان محدّث");
    assert.equal(s!.status, "SESSION_STATUS_STOPPED");
    assert.equal(s!.taskId, "task_restart");
    assert.deepEqual(store2.eventsAfter("ses_restart").map((e) => e.id), ["evt_r1", "evt_r2"]);
    assert.equal(store2.getSessionByTaskId("task_restart")?.sessionId, "ses_restart");
  });

  it("replays by cursor id and by sequence", () => {
    const store = new ProtocolStore();
    store.ensureSession("ses_cursor", "task_cursor", "Cursor");
    for (const id of ["evt_c1", "evt_c2", "evt_c3", "evt_c4", "evt_c5", "evt_c6"]) {
      store.appendEvent("ses_cursor", envelope(id, "ses_cursor", id));
    }

    // Cursor is the *log* seq of the frame (the envelope id is the payload id).
    const c3Seq = seqOfId("ses_cursor", "evt_c3");
    assert.ok(c3Seq, "evt_c3 should have a log sequence");
    assert.deepEqual(store.eventsAfter("ses_cursor", "evt_c3").map((e) => e.id), ["evt_c4", "evt_c5", "evt_c6"]);
    assert.deepEqual(store.eventsAfterSeq("ses_cursor", c3Seq!).map((e) => e.id), ["evt_c4", "evt_c5", "evt_c6"]);
    // An unknown cursor replays everything (the old findIndex(-1) behaviour).
    assert.deepEqual(store.eventsAfter("ses_cursor", "evt_missing").map((e) => e.id), ["evt_c1", "evt_c2", "evt_c3", "evt_c4", "evt_c5", "evt_c6"]);
    // A noPersistent frame is never persisted, so it is absent from both paths.
    store.appendEvent("ses_cursor", { ...envelope("evt_nop", "ses_cursor", "skip"), event: { ...envelope("evt_nop", "ses_cursor", "skip").event, noPersistent: true } });
    assert.equal(store.eventsAfter("ses_cursor").some((e) => e.id === "evt_nop"), false);
    assert.deepEqual(store.eventsAfter("ses_cursor").map((e) => e.id), ["evt_c1", "evt_c2", "evt_c3", "evt_c4", "evt_c5", "evt_c6"]);
  });

  it("never writes protocol-sessions.json once the legacy cache is imported", () => {
    restart();
    const store = new ProtocolStore();
    store.ensureSession("ses_nojson", "task_nojson", "No JSON");
    store.appendEvent("ses_nojson", envelope("evt_j1", "ses_nojson", "one"));
    store.setTitle("ses_nojson", "titled");

    // The file is byte-identical to the fixture written before the first import:
    // no live session was ever dumped into it, and it was not even re-serialised.
    assert.equal(fs.readFileSync(LEGACY_FILE, "utf8"), LEGACY_RAW_BEFORE);
    assert.ok(fs.existsSync(LEGACY_FILE + LEGACY_BACKUP_SUFFIX), "backup should exist");

    restart();
    const store2 = new ProtocolStore();
    const ids = store2.listSessions().map((s) => s.sessionId);
    for (const expected of ["ses_legacy_a", "ses_legacy_b", "ses_nojson"]) {
      assert.ok(ids.includes(expected), `expected ${expected} in ${ids.join(", ")}`);
    }
    assert.equal(store2.getSession("ses_nojson")!.title, "titled");
    assert.deepEqual(store2.eventsAfter("ses_nojson").map((e) => e.id), ["evt_j1"]);
  });

  it("imports the legacy cache in the constructor exactly once", () => {
    restart();
    const store = new ProtocolStore();
    const a = store.getSession("ses_legacy_a");
    assert.ok(a, "legacy session should be imported on construction");
    assert.equal(a!.title, "اختبار");
    assert.equal(a!.status, "SESSION_STATUS_RUNNING");
    assert.equal(a!.taskId, "task_a");
    assert.deepEqual(store.eventsAfter("ses_legacy_a").map((e) => e.id), ["evt_a1", "evt_a2"]);
    // The one-shot marker is durable, so a second construction imports nothing.
    assert.equal(database().prepare("SELECT value FROM metadata WHERE key=?").get(LEGACY_IMPORT_KEY) !== undefined, true);
  });

  it("folds soft delete and undelete back from the status events", () => {
    const store = new ProtocolStore();
    store.ensureSession("ses_del", "task_del", "Doomed");
    store.appendEvent("ses_del", envelope("evt_d1", "ses_del", "hi"));
    store.deleteTask("task_del");
    assert.equal(store.isDeleted("task_del"), true);
    assert.equal(store.listSessions().some((s) => s.sessionId === "ses_del"), false);

    restart();
    const store2 = new ProtocolStore();
    assert.equal(store2.isDeleted("task_del"), true);
    assert.equal(store2.getSession("ses_del")!.status, "SESSION_STATUS_DELETED");
    assert.equal(store2.listSessions().some((s) => s.sessionId === "ses_del"), false);

    store2.undeleteTask("task_del");
    assert.equal(store2.isDeleted("task_del"), false);
    restart();
    const store3 = new ProtocolStore();
    assert.equal(store3.isDeleted("task_del"), false);
    assert.deepEqual(store3.eventsAfter("ses_del").map((e) => e.id), ["evt_d1"]);
  });

  it("keeps setTaskId / bindTask consistent with the task index after a restart", () => {
    const store = new ProtocolStore();
    store.ensureSession("ses_bind", "", "Bound");
    store.setTaskId("ses_bind", "task_bind");
    assert.equal(store.getSessionByTaskId("task_bind")?.sessionId, "ses_bind");
    store.bindTask("ses_bind", "task_bind"); // idempotent
    store.setTaskId("ses_bind", "task_bind2");
    assert.equal(store.getSessionByTaskId("task_bind"), undefined);

    restart();
    const store2 = new ProtocolStore();
    assert.equal(store2.getSessionByTaskId("task_bind2")?.sessionId, "ses_bind");
    assert.equal(store2.getSessionByTaskId("task_bind"), undefined);
  });

  it("clear() drops the in-memory cache only (the log stays durable)", () => {
    const store = new ProtocolStore();
    store.ensureSession("ses_clear", "task_clear", "Cleared");
    store.appendEvent("ses_clear", envelope("evt_cl1", "ses_clear", "hi"));
    store.clear();
    assert.equal(store.getSession("ses_clear"), undefined);
    restart();
    const store2 = new ProtocolStore();
    assert.ok(store2.getSession("ses_clear"));
    assert.deepEqual(store2.eventsAfter("ses_clear").map((e) => e.id), ["evt_cl1"]);
  });

  it("purged sessions are gone for good", () => {
    const store = new ProtocolStore();
    store.ensureSession("ses_purge", "task_purge", "Purged");
    store.appendEvent("ses_purge", envelope("evt_p1", "ses_purge", "hi"));
    purgeSession("ses_purge");
    restart();
    const store2 = new ProtocolStore();
    assert.equal(store2.getSession("ses_purge"), undefined);
    assert.equal(store2.eventsAfter("ses_purge").length, 0);
    assert.equal(headSeq("ses_purge"), 0);
  });

  it("stores events in order with gap-free sequences across a restart", () => {
    const store = new ProtocolStore();
    store.ensureSession("ses_gap", "task_gap", "Gap");
    for (let i = 0; i < 4; i++) store.appendEvent("ses_gap", envelope(`evt_g${i}`, "ses_gap", `e${i}`));
    restart();
    const store2 = new ProtocolStore();
    const rows = afterSeq("ses_gap");
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(store2.eventsAfter("ses_gap").map((e) => e.id), ["evt_g0", "evt_g1", "evt_g2", "evt_g3"]);
    // New writes continue after the restarted head.
    store2.appendEvent("ses_gap", envelope("evt_g4", "ses_gap", "e4"));
    assert.deepEqual(store2.eventsAfter("ses_gap", "evt_g3").map((e) => e.id), ["evt_g4"]);
    assert.equal(seqOfId("ses_gap", "evt_g4"), 6);
  });
});
