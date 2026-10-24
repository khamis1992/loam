/**
 * J7 daemon hibernation: the manager's conservative boundary.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md — the same invariants,
 * pinned here with a deterministic clock so the idle transition needs no real
 * waiting:
 * - active work (a run signal) is never reclaimed;
 * - pending input is never reclaimed;
 * - a scheduled wake is never interrupted;
 * - repeated idle ticks do not repeatedly rebuild/discard the same caches;
 * - a release is a bounded `clear()` per owner, and a partial release is fine.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { HibernationManager, type CacheOwner } from "../hibernation.js";
import { resetSessionCaches, registerTaskCache, releaseTaskCaches, taskCacheBytes } from "../sessionCaches.js";

// `CacheOwner.bytes` is optional (an owner may not know its retained bytes), but
// `TaskCacheOwner.bytes` is required. This helper always provides one, so the
// return type states that explicitly and the same value satisfies both shapes.
function owner(name: string, size = 1, bytes = 0): CacheOwner & { cleared: number; bytes: () => number } {
  const o = {
    name,
    cleared: 0,
    size: () => size,
    bytes: () => bytes,
    clear: () => { o.cleared += 1; size = 0; bytes = 0; },
  };
  return o;
}

/** A manager whose clock the test advances by hand. */
function makeManager(idleMinutes = 30) {
  let now = 1_000_000;
  const manager = new HibernationManager({ idleMinutes, now: () => now });
  return {
    manager,
    advance: (ms: number) => { now += ms; },
    set: (ms: number) => { now = ms; },
  };
}

describe("HibernationManager", () => {
  beforeEach(() => {
    resetSessionCaches();
  });

  it("releases an idle session's derived caches after the threshold", async () => {
    const { manager, advance } = makeManager(30);
    const a = owner("projection", 3, 64);
    const b = owner("frames", 1, 1024);
    manager.setOwners("s1", [a, b]);
    manager.markIdle("s1");

    // Not yet idle long enough: the sweep must not release anything.
    advance(29 * 60_000);
    let sweep = await manager.sweep();
    assert.equal(sweep.hibernated, 0);
    assert.equal(a.cleared, 0);
    assert.equal(manager.getState("s1"), "idle");

    // Past the threshold: exactly one release.
    advance(60_000);
    sweep = await manager.sweep();
    assert.equal(sweep.hibernated, 1);
    assert.equal(a.cleared, 1);
    assert.equal(b.cleared, 1);
    assert.equal(sweep.entriesReleased, 4);
    assert.equal(sweep.bytesReleased, 1088);
    assert.equal(manager.getState("s1"), "hibernated");
    manager.stop();
  });

  it("never releases a session with active work", async () => {
    const { manager, advance } = makeManager(1);
    const a = owner("projection", 2);
    manager.setOwners("s1", [a]);
    manager.setGuards("s1", { running: () => true });
    manager.markIdle("s1");
    advance(120_000);

    const sweep = await manager.sweep();
    assert.equal(sweep.hibernated, 0);
    assert.deepEqual(sweep.skipped, [{ sessionId: "s1", reason: "active-work" }]);
    assert.equal(a.cleared, 0);
    assert.equal(manager.getState("s1"), "idle");
    manager.stop();
  });

  it("never releases a session with pending input", async () => {
    const { manager, advance } = makeManager(1);
    const a = owner("projection", 2);
    manager.setOwners("s1", [a]);
    manager.setGuards("s1", { pendingInput: () => true });
    manager.markIdle("s1");
    advance(120_000);

    const sweep = await manager.sweep();
    assert.equal(sweep.hibernated, 0);
    assert.deepEqual(sweep.skipped, [{ sessionId: "s1", reason: "pending-input" }]);
    assert.equal(a.cleared, 0);
    manager.stop();
  });

  it("never releases a session with a scheduled wake in flight", async () => {
    const { manager, advance } = makeManager(1);
    const a = owner("projection", 2);
    manager.setOwners("s1", [a]);
    manager.setGuards("s1", { scheduledWake: () => true });
    manager.markIdle("s1");
    advance(120_000);

    const sweep = await manager.sweep();
    assert.equal(sweep.hibernated, 0);
    assert.deepEqual(sweep.skipped, [{ sessionId: "s1", reason: "scheduled-wake" }]);
    assert.equal(a.cleared, 0);
    manager.stop();
  });

  it("does not release the same caches twice on repeated sweeps", async () => {
    const { manager, advance } = makeManager(1);
    const a = owner("projection", 4, 32);
    manager.setOwners("s1", [a]);
    manager.markIdle("s1");
    advance(120_000);

    const first = await manager.sweep();
    assert.equal(first.hibernated, 1);
    const second = await manager.sweep();
    assert.equal(second.hibernated, 0);
    assert.equal(a.cleared, 1);
    assert.equal(second.entriesReleased, 0);
    manager.stop();
  });

  it("a throwing owner is a partial release, not a failure of the sweep", async () => {
    const { manager, advance } = makeManager(1);
    const bad: CacheOwner = {
      name: "broken",
      size: () => 1,
      clear: () => { throw new Error("boom"); },
    };
    const good = owner("good", 2, 16);
    manager.setOwners("s1", [bad, good]);
    manager.markIdle("s1");
    advance(120_000);

    const record = manager.hibernateSession("s1", { immediate: true });
    assert.equal(record.state, "hibernated");
    assert.match(record.lastError ?? "", /release failed for broken/);
    assert.equal(good.cleared, 1);
    manager.stop();
  });

  it("the disable setting (0) turns the whole feature off", async () => {
    const { manager, advance } = makeManager(0);
    const a = owner("projection", 2);
    manager.setOwners("s1", [a]);
    manager.markIdle("s1");
    advance(60_000);

    assert.equal(manager.disabled, true);
    const record = manager.hibernateSession("s1", { immediate: true });
    assert.notEqual(record.state, "hibernated");
    assert.equal(a.cleared, 0);
    const sweep = await manager.sweep();
    assert.equal(sweep.hibernated, 0);
    manager.stop();
  });

  it("reports ms until hibernation only while idle", () => {
    const { manager, advance } = makeManager(30);
    assert.equal(manager.msUntilHibernation("s1"), undefined);
    manager.markIdle("s1");
    assert.equal(manager.msUntilHibernation("s1"), 30 * 60_000);
    advance(10 * 60_000);
    assert.equal(manager.msUntilHibernation("s1"), 20 * 60_000);
    manager.wake("s1", "user-input");
    assert.equal(manager.msUntilHibernation("s1"), undefined);
    manager.stop();
  });

  it("wake makes the session active again without rebuilding anything", () => {
    const { manager } = makeManager(30);
    manager.setOwners("s1", [owner("projection", 1)]);
    manager.markIdle("s1");
    manager.hibernateSession("s1", { immediate: true });
    assert.equal(manager.getState("s1"), "hibernated");
    manager.wake("s1", "user-input");
    assert.equal(manager.getState("s1"), "active");
    manager.stop();
  });

  it("exposes counters for the debug surface", async () => {
    const { manager, advance } = makeManager(1);
    manager.setOwners("s1", [owner("projection", 3, 64)]);
    manager.markIdle("s1");
    advance(120_000);
    await manager.sweep();
    const stats = manager.stats();
    assert.equal(stats.sessions, 1);
    assert.equal(stats.hibernated, 1);
    assert.equal(stats.hibernations, 1);
    assert.equal(stats.entriesReleased, 3);
    assert.equal(stats.bytesReleased, 64);
    assert.equal(stats.idleMinutes, 1);
    assert.equal(stats.disabled, false);
    assert.ok(stats.lastSweep);
    assert.equal(typeof stats.lastSweep.beforeBytes, "number");
    assert.equal(typeof stats.lastSweep.afterBytes, "number");
    manager.stop();
  });
});

describe("sessionCaches", () => {
  beforeEach(() => {
    resetSessionCaches();
  });

  it("releases only the requested task's derived caches", () => {
    const a = owner("a-projection", 1, 8);
    const b = owner("b-projection", 1, 8);
    registerTaskCache("task-a", a);
    registerTaskCache("task-b", b);

    const before = taskCacheBytes("task-a");
    assert.equal(before.entries, 1);

    const released = releaseTaskCaches("task-a");
    assert.equal(released.entries, 1);
    assert.deepEqual(released.owners, ["a-projection"]);
    assert.equal(taskCacheBytes("task-a").entries, 0);
    // The other session's derived state is untouched.
    assert.equal(taskCacheBytes("task-b").entries, 1);
    assert.equal(b.cleared, 0);
  });

  it("re-releasing an already released task is a no-op", () => {
    registerTaskCache("task-a", owner("a-projection", 1, 8));
    releaseTaskCaches("task-a");
    const again = releaseTaskCaches("task-a");
    assert.equal(again.entries, 0);
    assert.deepEqual(again.owners, []);
  });
});
