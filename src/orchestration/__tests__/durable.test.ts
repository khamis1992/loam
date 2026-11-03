import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexCheckpoint, listCheckpoints, lineage, planFork, forksOf, resetCheckpointSchemaFlag } from "../durable/checkpoints.js";
import { createCheckpointSink } from "../durable/durability.js";
import {
  createInterrupt,
  resolveInterrupt,
  waitForInterrupt,
  expireDue,
  cancelInterruptsForTask,
  pendingInterrupts,
  dismissInterrupt,
  getInterrupt,
  InterruptLimitError,
  RESPONSE_SCHEMAS,
  resetInterruptSchemaFlag,
  onInterruptChange,
} from "../durable/interrupts.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-orch-durable-"));
process.env.LOAM_DATA_DIR = tmp;
process.env.MANUS_LOCAL_DATA_DIR = tmp;
const { resetDb } = await import("../../server/sqliteStore.js");
resetCheckpointSchemaFlag();
resetInterruptSchemaFlag();

const cp = (round: number, nextStep: number, done: number, complete = false) => ({ round, nextStep, completed: new Array(done).fill(0), complete });

test("indexCheckpoint links parents, is idempotent per log seq, and enforces retention", () => {
  const a = indexCheckpoint({ taskId: "t1", sessionId: "t1", logSeq: 10, cp: cp(0, 0, 0), keep: 3 });
  const b = indexCheckpoint({ taskId: "t1", sessionId: "t1", logSeq: 12, cp: cp(0, 1, 1), keep: 3 });
  const again = indexCheckpoint({ taskId: "t1", sessionId: "t1", logSeq: 12, cp: cp(0, 1, 1), keep: 3 });
  assert.equal(again.checkpointId, b.checkpointId);
  assert.equal(b.parentCheckpointId, a.checkpointId);
  for (let s = 14; s <= 20; s += 2) indexCheckpoint({ taskId: "t1", sessionId: "t1", logSeq: s, cp: cp(0, s, s), keep: 3 });
  const fin = indexCheckpoint({ taskId: "t1", sessionId: "t1", logSeq: 22, cp: cp(1, 5, 5, true), keep: 3 });
  assert.equal(fin.source, "final");
  const list = listCheckpoints("t1");
  assert.equal(list.filter((c) => c.source === "loop").length, 3);
  assert.equal(list[0]?.checkpointId, fin.checkpointId);
  assert.ok(lineage(fin.checkpointId).length >= 2);
});

test("planFork copies a historic checkpoint body and records the fork", () => {
  const ref = indexCheckpoint({ taskId: "t2", sessionId: "t2", logSeq: 5, cp: cp(0, 2, 2), keep: 50 });
  const body = { version: 1, round: 0, nextStep: 2, completed: [1, 2], plan: ["a", "b", "c"], logSeq: 5, logSessionId: "t2", complete: false };
  const fork = planFork<typeof body>(ref.checkpointId, (s, seq) => (s === "t2" && seq === 5 ? body : undefined), {
    note: "try another approach",
    edit: (c) => ({ ...c, plan: ["a", "b", "c2"] }),
  });
  assert.equal(fork.checkpoint.logSeq, undefined);
  assert.equal(fork.checkpoint.logSessionId, undefined);
  assert.deepEqual(fork.checkpoint.plan, ["a", "b", "c2"]);
  assert.deepEqual(body.plan, ["a", "b", "c"], "source body untouched");
  assert.equal(forksOf("t2")[0]?.forkTaskId, fork.forkTaskId);
  assert.throws(() => planFork("ck_missing", () => undefined), /checkpoint_not_found/);
});

test("durability sinks: sync writes now, async next tick in order, exit only on flush", async () => {
  const w: number[] = [];
  const sync = createCheckpointSink<number>("sync", (n) => w.push(n));
  sync.save(1);
  assert.deepEqual(w, [1]);
  const asy = createCheckpointSink<number>("async", (n) => w.push(n));
  asy.save(2);
  asy.save(3);
  assert.deepEqual(w, [1]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w, [1, 2, 3]);
  const exit = createCheckpointSink<number>("exit", (n) => w.push(n));
  exit.save(4);
  exit.save(5);
  assert.equal(exit.pending(), 1);
  assert.deepEqual(w, [1, 2, 3]);
  exit.flush();
  assert.deepEqual(w, [1, 2, 3, 5]);
});

test("schema-checked resolve wakes the waiter exactly once", async () => {
  const rec = createInterrupt({ taskId: "t3", kind: "stalled_replan", payload: { why: "loop" }, responseSchema: RESPONSE_SCHEMAS.stalled_replan, ttlMs: 60_000, maxPendingPerTask: 5 });
  const seen: Array<string | undefined> = [];
  const p1 = waitForInterrupt<{ decision: "continue" }>(rec.interruptId).then((r) => seen.push(r?.status ?? "none"));
  const p2 = waitForInterrupt(rec.interruptId).then((r) => seen.push(r?.status ?? "none"));
  await new Promise((r) => setImmediate(r));
  const bad = resolveInterrupt(rec.interruptId, { decision: "nope" } as never);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.error, "invalid_response");
  const ok = resolveInterrupt<{ decision: "continue" }>(rec.interruptId, { decision: "continue" });
  assert.equal(ok.ok, true);
  await Promise.all([p1, p2]);
  assert.deepEqual(seen, ["resolved", "resolved"]);
  const again = resolveInterrupt(rec.interruptId, { decision: "continue" });
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.error, "not_pending");
});

test("per-task limit, dismiss, cancel and expiry", () => {
  for (let i = 0; i < 3; i++) createInterrupt({ taskId: "t4", kind: "custom", payload: {}, responseSchema: { type: "object" }, ttlMs: 60_000, maxPendingPerTask: 3 });
  assert.throws(() => createInterrupt({ taskId: "t4", kind: "custom", payload: {}, responseSchema: { type: "object" }, ttlMs: 60_000, maxPendingPerTask: 3 }), InterruptLimitError);
  const ids = pendingInterrupts("t4").map((r) => r.interruptId);
  assert.equal(ids.length, 3);
  assert.equal(dismissInterrupt(ids[0] as string), true);
  const expired = createInterrupt({ taskId: "t4", kind: "custom", payload: {}, responseSchema: { type: "object" }, ttlMs: 1, maxPendingPerTask: 5, now: Date.now() - 10 });
  assert.equal(expireDue(Date.now()) >= 1, true);
  assert.equal(getInterrupt(expired.interruptId)?.status, "expired");
  assert.equal(cancelInterruptsForTask("t4") >= 2, true);
  assert.equal(pendingInterrupts("t4").length, 0);
});

test("aborting a waiter leaves the record pending", async () => {
  const ac = new AbortController();
  const rec = createInterrupt({ taskId: "t5", kind: "custom", payload: {}, responseSchema: { type: "object" }, ttlMs: 60_000, maxPendingPerTask: 5 });
  const out = waitForInterrupt(rec.interruptId, ac.signal).then((r) => r?.status ?? "aborted");
  await new Promise((r) => setImmediate(r));
  ac.abort();
  assert.equal(await out, "aborted");
  assert.equal(getInterrupt(rec.interruptId)?.status, "pending");
});

test("a pending interrupt survives losing all in-memory state", () => {
  const rec = createInterrupt({ taskId: "t6", kind: "custom", payload: { k: 1 }, responseSchema: { type: "object" }, ttlMs: 60_000, maxPendingPerTask: 5 });
  resetInterruptSchemaFlag(); // drops every waiter and listener, as a restart would
  const back = getInterrupt(rec.interruptId);
  assert.equal(back?.status, "pending");
  assert.deepEqual(back?.payload, { k: 1 });
  const fired: string[] = [];
  const off = onInterruptChange((r) => fired.push(r.status));
  resolveInterrupt(rec.interruptId, {});
  off();
  assert.deepEqual(fired, ["resolved"]);
});

test.after(() => { try { resetDb(); } catch { /* closed */ } });
