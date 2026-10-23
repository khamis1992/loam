/**
 * Tests for the durable append-only event log (BUILD_SPEC §6.1).
 *
 * `LOAM_DATA_DIR` is pointed at a throwaway temp dir before the module is
 * imported, so the real app `data/` folder is never touched. `resetDb()` drops
 * the shared SQLite connection, which stands in for a process restart.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-eventlog-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import { database, closeDb, resetDb } from "../../server/sqliteStore.js";
import {
  after as afterSeq,
  append,
  headSeq,
  lastOfKind,
  purgeSession,
  seqOfId,
  sessionIds,
} from "../eventLog.js";
import type { LogKind } from "../eventLog.js";

function restart(): void {
  closeDb();
  resetDb();
}

function eachKind(): LogKind[] {
  return ["input", "chat_event", "tool_result", "checkpoint", "status"];
}

describe("eventLog", () => {
  before(() => {
    restart();
  });

  it("allocates gap-free sequence numbers 1..N per session", () => {
    const seqs = Array.from({ length: 5 }, (_, i) => append("s_gapfree", "status", { n: i }).seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    assert.equal(headSeq("s_gapfree"), 5);

    const rows = afterSeq("s_gapfree");
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(rows.map((r) => r.payload), [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  });

  it("keeps sequences independent per session", () => {
    append("s_a", "status", { who: "a" });
    append("s_b", "status", { who: "b" });
    append("s_a", "status", { who: "a2" });
    assert.deepEqual(afterSeq("s_a").map((r) => r.seq), [1, 2]);
    assert.deepEqual(afterSeq("s_b").map((r) => r.seq), [1]);
    assert.deepEqual(sessionIds().sort(), ["s_a", "s_b", "s_gapfree"]);
  });

  it("is idempotent: the same idempotency key returns the same event", () => {
    const first = append("s_idem", "chat_event", { text: "first" }, { idempotencyKey: "key-1" });
    const second = append("s_idem", "chat_event", { text: "second" }, { idempotencyKey: "key-1" });
    assert.equal(second.seq, first.seq);
    assert.equal(second.id, first.id);
    assert.deepEqual(second.payload, { text: "first" });
    assert.equal(headSeq("s_idem"), 1);
    assert.equal(afterSeq("s_idem").length, 1);

    // A different key still appends normally.
    const third = append("s_idem", "chat_event", { text: "third" }, { idempotencyKey: "key-2" });
    assert.equal(third.seq, 2);
  });

  it("scopes idempotency keys to their session", () => {
    append("s_scope_a", "status", { who: "a" }, { idempotencyKey: "shared" });
    append("s_scope_b", "status", { who: "b" }, { idempotencyKey: "shared" });
    assert.deepEqual(afterSeq("s_scope_a", 0, 10).map((r) => r.seq), [1]);
    assert.deepEqual(afterSeq("s_scope_b", 0, 10).map((r) => r.seq), [1]);
  });

  it("persists events across a restart", () => {
    append("s_restart", "status", { title: "kept" });
    restart();
    assert.equal(headSeq("s_restart"), 1);
    assert.deepEqual(afterSeq("s_restart")[0]!.payload, { title: "kept" });
  });

  it("rejects UPDATE on session_events", () => {
    const ev = append("s_update", "status", { status: "created" });
    assert.throws(
      () => database().prepare("UPDATE session_events SET payload=? WHERE session_id=? AND seq=?").run("{}", "s_update", ev.seq),
      /immutable/i,
    );
    assert.deepEqual(afterSeq("s_update")[0]!.payload, { status: "created" });
  });

  it("rejects DELETE on session_events", () => {
    const ev = append("s_delete", "status", { status: "created" });
    assert.throws(
      () => database().prepare("DELETE FROM session_events WHERE session_id=? AND seq=?").run("s_delete", ev.seq),
      /immutable/i,
    );
    assert.equal(headSeq("s_delete"), 1);
  });

  it("purgeSession deletes rows, and only that session's rows", () => {
    append("s_purge_me", "status", { who: "doomed" });
    append("s_purge_me", "status", { who: "doomed again" });
    append("s_keep_me", "status", { who: "safe" });
    const removed = purgeSession("s_purge_me");
    assert.equal(removed, 2);
    assert.deepEqual(afterSeq("s_purge_me"), []);
    assert.equal(headSeq("s_purge_me"), 0);
    assert.deepEqual(afterSeq("s_keep_me").map((r) => r.payload), [{ who: "safe" }]);
    // The escape hatch is cleared again, so DELETE is blocked once more.
    append("s_purge_me", "status", { who: "resurrected" });
    assert.throws(
      () => database().prepare("DELETE FROM session_events WHERE session_id=?").run("s_purge_me"),
      /immutable/i,
    );
  });

  it("rejects unknown kinds and circular payloads", () => {
    assert.throws(
      () => append("s_bad_kind", "nope" as LogKind, { ok: true }),
      /constraint/i,
    );
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.throws(
      () => append("s_bad_payload", "status", { circular }),
      /circular/i,
    );
  });

  it("supports the read helpers used by later tasks", () => {
    const cp = append("s_helpers", "checkpoint", { nextStep: 1 }, { turnId: "turn_9" });
    assert.equal(lastOfKind("s_helpers", "checkpoint")!.seq, cp.seq);
    assert.equal(lastOfKind("s_helpers", "input"), undefined);
    assert.equal(seqOfId("s_helpers", cp.id), cp.seq);
    assert.equal(seqOfId("s_helpers", "evt_missing"), undefined);
    assert.deepEqual(afterSeq("s_helpers", cp.seq), []);
    assert.equal(afterSeq("s_helpers", cp.seq - 1).length, 1);
    for (const kind of eachKind()) append("s_all_kinds", kind, { kind });
    assert.equal(headSeq("s_all_kinds"), eachKind().length);
    assert.deepEqual(afterSeq("s_all_kinds").map((r) => r.kind), eachKind());
  });

  it("keeps an explicit id and turn id on the event", () => {
    const ev = append("s_fields", "input", { text: "مرحبا" }, { id: "evt_explicit", turnId: "turn_1" });
    assert.equal(ev.id, "evt_explicit");
    assert.equal(ev.turnId, "turn_1");
    assert.equal(ev.idempotencyKey, null);
    assert.deepEqual(afterSeq("s_fields")[0]!.payload, { text: "مرحبا" });
  });
});
