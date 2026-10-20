import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

type Lease = typeof import("../runLease.js");
type Db = typeof import("../db.js");

let tmpDir = "";
let closeDb: () => void;
let lease: Lease;
let db: Db;

describe("run lease fencing", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-run-lease-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    lease = await import("../runLease.js");
    db = await import("../db.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("two claimers: only one wins, same-owner re-claim is idempotent", () => {
    const taskId = "lease-two-claimers";
    const a = lease.claimRunLease(taskId, "runner-a");
    assert.equal(a.owner, "runner-a");
    assert.equal(a.token, 1);
    const again = lease.claimRunLease(taskId, "runner-a");
    assert.equal(again.token, a.token, "same live owner re-claims the identical lease");
    assert.throws(() => lease.claimRunLease(taskId, "runner-b"), /already leased by runner-a/);
    assert.throws(() => lease.claimRunLease(taskId, "runner-c"), /already leased by runner-a/);
  });

  it("renew extends expiry without changing the token", () => {
    const taskId = "lease-renew";
    const now = Date.now();
    const a = lease.claimRunLease(taskId, "runner-a", now);
    const renewed = lease.renewRunLease(a, now + lease.LEASE_HEARTBEAT_MS);
    assert.equal(renewed.token, a.token);
    assert.equal(renewed.owner, a.owner);
    assert.equal(renewed.expiresAt, now + lease.LEASE_HEARTBEAT_MS + lease.LEASE_TTL_MS);
    assert.ok(lease.isLeaseLive(lease.getRunLease(taskId)));
  });

  it("stale token writes are rejected after a takeover", () => {
    const task = db.createTask("fence test", "fence");
    const a = lease.claimRunLease(task.id, "runner-a");
    db.setTaskStatus(task.id, "running", undefined, a);
    assert.equal(db.getTask(task.id)?.status, "running");
    lease.releaseRunLease(a);
    const b = lease.claimRunLease(task.id, "runner-b");
    assert.equal(b.token, a.token + 1, "takeover bumps the token");
    assert.throws(() => lease.assertRunLease(a), /no longer held/);
    assert.throws(() => lease.renewRunLease(a), /no longer held/);
    assert.throws(() => db.setTaskStatus(task.id, "done", undefined, a), /no longer held/);
    assert.throws(() => db.completeTaskRun(task.id, "result", "model", a), /no longer held/);
    assert.throws(() => db.saveRun(task.id, { prompt: "p", effectivePrompt: "p", history: [], workspace: ".", orchestrated: false, started: true }, a), /no longer held/);
    assert.equal(db.getTask(task.id)?.status, "running", "fenced writes must not mutate task state");
    lease.releaseRunLease(a);
    assert.equal(lease.isLeaseLive(lease.getRunLease(task.id)), true, "stale release must not tombstone the new owner's lease");
    lease.releaseRunLease(b);
    assert.equal(lease.isLeaseLive(lease.getRunLease(task.id)), false);
    assert.equal(lease.getRunLease(task.id)?.token, b.token, "tombstone keeps the token for monotonicity");
  });

  it("expired lease is recovered with an incremented token", () => {
    const taskId = "lease-expiry";
    const now = Date.now();
    const a = lease.claimRunLease(taskId, "runner-a", now);
    assert.equal(a.token, 1);
    const b = lease.claimRunLease(taskId, "runner-b", now + lease.LEASE_TTL_MS + 1);
    assert.equal(b.owner, "runner-b");
    assert.equal(b.token, a.token + 1);
    assert.ok(b.expiresAt > now + lease.LEASE_TTL_MS + 1);
    assert.throws(() => lease.assertRunLease(a, now + lease.LEASE_TTL_MS + 1), /no longer held/);
  });

  it("heartbeat renews the lease and stop() releases the timer", async () => {
    const taskId = "lease-heartbeat";
    const now = Date.now();
    const a = lease.claimRunLease(taskId, "runner-a", now);
    const hb = lease.startLeaseHeartbeat(a, undefined, 25);
    await new Promise((r) => setTimeout(r, 120));
    const stored = lease.getRunLease(taskId);
    assert.ok(stored && stored.expiresAt > now + lease.LEASE_TTL_MS, `heartbeat must have renewed expiry, got ${stored?.expiresAt}`);
    assert.equal(stored?.token, a.token);
    hb.stop();
  });

  it("heartbeat reports a lost lease once and stops renewing", async () => {
    const taskId = "lease-heartbeat-loss";
    const a = lease.claimRunLease(taskId, "runner-a");
    lease.releaseRunLease(a);
    await lease.claimRunLease(taskId, "runner-b");
    let lost: unknown;
    let calls = 0;
    const hb = lease.startLeaseHeartbeat(a, (error) => { calls++; lost = error; }, 25);
    await new Promise((r) => setTimeout(r, 120));
    hb.stop();
    assert.equal(calls, 1, `onLost fires once, got ${calls}`);
    assert.ok(lost instanceof Error && /no longer held/.test(lost.message));
  });

  it("recovery tombstones stale leases so the token stays monotonic", () => {
    const task = db.createTask("recovery lease test", "recovery");
    const a = lease.claimRunLease(task.id, "runner-a");
    db.setTaskStatus(task.id, "running", undefined, a);
    assert.ok(db.recoverInterruptedTasks() > 0);
    const stored = lease.getRunLease(task.id);
    assert.ok(stored && stored.expiresAt === 0, "boot recovery must tombstone live leases");
    const b = lease.claimRunLease(task.id, "runner-b");
    assert.equal(b.token, a.token + 1, "post-recovery claim increments the token");
    assert.throws(() => lease.assertRunLease(a), /no longer held/);
    lease.releaseRunLease(b);
  });
});
