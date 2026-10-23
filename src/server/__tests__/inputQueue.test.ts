/**
 * Tests for the durable inbound message queue (BUILD_SPEC §6.6).
 *
 * `LOAM_DATA_DIR` points at a throwaway temp dir before the module is imported,
 * so the real app `data/` folder is never touched. `closeDb()` + `resetDb()`
 * drops the shared SQLite connection, which stands in for a process restart.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-inputqueue-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import { closeDb, putEntity, resetDb } from "../sqliteStore.js";
import { after as afterSeq, headSeq } from "../../protocol/eventLog.js";
import {
  admitAllPending,
  admitPending,
  cancel,
  drop,
  enqueue,
  hasPending,
  markAdmitted,
  newInputId,
  pending,
} from "../inputQueue.js";
import type { QueuedInput } from "../inputQueue.js";

function restart(): void {
  closeDb();
  resetDb();
}

function send(sessionId: string, text: string, delivery: "queued" | "steering" = "queued"): QueuedInput {
  return enqueue({ id: newInputId(), sessionId, text, delivery });
}

describe("inputQueue", () => {
  before(() => {
    restart();
  });

  after(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores a message as received without appending a log event", () => {
    const q = send("s_basic", "hello");
    assert.equal(q.state, "received");
    assert.equal(q.delivery, "queued");
    assert.ok(q.receivedAt > 0);
    assert.equal(q.admittedSeq, undefined);
    assert.deepEqual(pending("s_basic").map((p) => p.id), [q.id]);
    // Nothing is durable in the log until the agent admits it.
    assert.equal(headSeq("s_basic"), 0);
  });

  it("keeps sessions isolated", () => {
    send("s_iso_a", "a");
    send("s_iso_b", "b");
    assert.equal(pending("s_iso_a").length, 1);
    assert.equal(pending("s_iso_b").length, 1);
    assert.equal(pending("s_iso_a")[0]!.text, "a");
    assert.equal(hasPending("s_iso_a"), true);
    assert.equal(hasPending("s_missing"), false);
    assert.deepEqual(pending("s_missing"), []);
  });

  it("admits pending messages once, in arrival order, as durable input events", () => {
    const first = send("s_admit", "one");
    const second = send("s_admit", "two");
    const admitted = admitPending("s_admit");

    assert.deepEqual(admitted.map((a) => a.text), ["one", "two"]);
    assert.deepEqual(admitted.map((a) => a.admittedSeq), [1, 2]);
    assert.deepEqual(afterSeq("s_admit").map((r) => r.kind), ["input", "input"]);
    assert.deepEqual(afterSeq("s_admit").map((r) => r.payload), [
      { text: "one", actor: "user", inputId: first.id },
      { text: "two", actor: "user", inputId: second.id },
    ]);

    // The queue is now empty, and a second admission writes nothing new.
    assert.deepEqual(pending("s_admit"), []);
    assert.equal(hasPending("s_admit"), false);
    assert.deepEqual(admitPending("s_admit"), []);
    assert.equal(headSeq("s_admit"), 2);
  });

  it("is idempotent across a crash between append and markAdmitted", () => {
    const q = send("s_crash", "survives");
    // Simulate: the event was appended, but the process died before the queue
    // row was flipped to `admitted`. The row is still `received` on restart.
    admitPending("s_crash");
    const stale = pending("s_crash");
    assert.deepEqual(stale, []);

    // Force the row back to `received` to model the torn write.
    const row = enqueue({ id: q.id, sessionId: "s_crash", text: "survives", delivery: "queued" });
    assert.equal(row.state, "received");
    const retry = admitPending("s_crash");
    assert.equal(retry.length, 1);
    // Same idempotency key, so the log did not grow a duplicate row.
    assert.equal(headSeq("s_crash"), 1);
    assert.equal(retry[0]!.admittedSeq, 1);
    assert.equal(afterSeq("s_crash").length, 1);
  });

  it("survives a restart: received messages are still pending", () => {
    const q = send("s_restart", "still here");
    assert.equal(headSeq("s_restart"), 0);

    restart();

    const restored = pending("s_restart");
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.id, q.id);
    assert.equal(restored[0]!.text, "still here");
    assert.equal(restored[0]!.state, "received");

    // And it is admitted exactly once after the restart.
    const admitted = admitPending("s_restart");
    assert.equal(admitted.length, 1);
    assert.deepEqual(afterSeq("s_restart").map((r) => r.payload), [
      { text: "still here", actor: "user", inputId: q.id },
    ]);
  });

  it("does not re-admit already-admitted messages after a restart", () => {
    send("s_done", "handled");
    admitPending("s_done");
    restart();
    assert.deepEqual(pending("s_done"), []);
    assert.deepEqual(admitPending("s_done"), []);
    assert.equal(headSeq("s_done"), 1);
  });

  it("markAdmitted records the sequence and ignores unknown ids", () => {
    const q = send("s_mark", "x");
    markAdmitted(q.id, 42);
    assert.deepEqual(pending("s_mark"), []);
    markAdmitted("in_does_not_exist", 7); // must not throw
  });

  it("cancel drops a waiting message and refuses to cancel an admitted one", () => {
    const q = send("s_cancel", "never mind");
    assert.equal(cancel(q.id), true);
    assert.deepEqual(pending("s_cancel"), []);
    assert.equal(headSeq("s_cancel"), 0);
    assert.equal(cancel(q.id), false);

    const kept = send("s_cancel2", "keep me");
    admitPending("s_cancel2");
    assert.equal(cancel(kept.id), false);
    assert.equal(headSeq("s_cancel2"), 1);
  });

  it("drop removes the queue row outright", () => {
    const q = send("s_drop", "gone");
    assert.equal(drop(q.id), true);
    assert.equal(drop(q.id), false);
    assert.deepEqual(pending("s_drop"), []);
  });

  it("admitAllPending sweeps every session, as the boot hook does", () => {
    send("s_boot_a", "a1");
    send("s_boot_a", "a2");
    send("s_boot_b", "b1");
    admitPending("s_boot_a"); // already admitted: must not be counted twice

    // The sweep is process-wide, so earlier tests' leftovers may be swept up too.
    // Assert on our own sessions rather than on the exact global result.
    const admitted = admitAllPending();
    const texts = admitted.map((a) => a.text);
    assert.ok(texts.includes("b1"), `expected b1 in ${JSON.stringify(texts)}`);
    assert.ok(!texts.includes("a1"), "already-admitted a1 must not be swept again");
    assert.ok(!texts.includes("a2"), "already-admitted a2 must not be swept again");
    assert.equal(headSeq("s_boot_a"), 2);
    assert.equal(headSeq("s_boot_b"), 1);
    // Nothing anywhere is left waiting, and a second sweep is a no-op.
    assert.equal(admitAllPending().length, 0);
    assert.equal(hasPending("s_boot_a"), false);
    assert.equal(hasPending("s_boot_b"), false);
  });

  it("admits in arrival order even when timestamps tie", () => {
    // Write three rows with an identical `receivedAt` directly, since two real
    // messages can land in the same millisecond. Order must follow insertion.
    const at = Date.now();
    for (const suffix of ["t1", "t2", "t3"]) {
      // Typed as a variable: `putEntity` only declares `{ id: string }`, so an
      // inline object literal would trip the excess-property check.
      const row: QueuedInput = {
        id: `in_tie_${suffix}`,
        sessionId: "s_tie",
        text: suffix,
        delivery: "queued",
        state: "received",
        receivedAt: at,
      };
      putEntity("inputs", row);
    }
    assert.deepEqual(pending("s_tie").map((p) => p.text), ["t1", "t2", "t3"]);
    assert.deepEqual(admitPending("s_tie").map((a) => a.text), ["t1", "t2", "t3"]);
    assert.deepEqual(afterSeq("s_tie").map((r) => (r.payload as { text: string }).text), ["t1", "t2", "t3"]);
  });

  it("keeps steering and queued delivery distinct", () => {
    send("s_delivery", "interrupt me", "steering");
    send("s_delivery", "wait your turn", "queued");
    assert.deepEqual(pending("s_delivery").map((p) => p.delivery), ["steering", "queued"]);
    assert.deepEqual(admitPending("s_delivery").map((a) => a.text), ["interrupt me", "wait your turn"]);
  });
});
