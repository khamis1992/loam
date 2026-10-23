import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";

import { SessionSleepManager, DEFAULT_IDLE_MINUTES, type SleepHooks } from "../sessionSleep.js";

/** Fake clock: tests advance time explicitly instead of waiting real minutes. */
class FakeClock {
  nowMs = 1_000_000;
  now = (): number => this.nowMs;
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

function recordingHooks(): SleepHooks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    persist: () => { calls.push("persist"); },
    release: () => { calls.push("release"); },
    restore: () => { calls.push("restore"); },
  };
}

describe("session sleep lifecycle", () => {
  let clock: FakeClock;
  let manager: SessionSleepManager;

  beforeEach(() => {
    clock = new FakeClock();
  });

  afterEach(() => {
    manager?.close();
  });

  it("uses a 30 minute idle threshold by default", () => {
    manager = new SessionSleepManager({ now: clock.now });
    assert.equal(DEFAULT_IDLE_MINUTES, 30);
    assert.equal(manager.idleThresholdMs, 30 * 60_000);
  });

  it("transitions idle -> sleeping after the idle threshold", async () => {
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now });
    assert.equal(manager.getState("s1"), "active");

    manager.markIdle("s1");
    assert.equal(manager.getState("s1"), "idle");
    assert.equal(manager.isSleeping("s1"), false);

    // 29 minutes: still idle, nothing released.
    clock.advance(29 * 60_000);
    assert.equal(manager.getState("s1"), "idle");

    clock.advance(1 * 60_000); // exactly 30 minutes
    const swept = await manager.sweep();
    assert.deepEqual(swept, [{ sessionId: "s1", slept: true, reason: "idle-timeout" }]);
    assert.equal(manager.getState("s1"), "sleeping");
    assert.equal(manager.isSleeping("s1"), true);
    assert.equal(manager.getRecord("s1")?.sleeps, 1);
    assert.ok(manager.getRecord("s1")?.sleptAt !== undefined);
  });

  it("persists state BEFORE releasing resources", async () => {
    const hooks = recordingHooks();
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now, hooks: { s1: hooks } });
    manager.markIdle("s1");
    await manager.sleep("s1", "idle-timeout");
    assert.deepEqual(hooks.calls, ["persist", "release"]);
    assert.equal(manager.getState("s1"), "sleeping");
  });

  it("never releases resources when persisting fails", async () => {
    const hooks: SleepHooks & { calls: string[] } = {
      calls: [],
      persist: () => {
        hooks.calls.push("persist");
        throw new Error("disk full");
      },
      release: () => { hooks.calls.push("release"); },
      restore: () => { hooks.calls.push("restore"); },
    };
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now, hooks: { s1: hooks } });
    manager.markIdle("s1");
    const record = await manager.sleep("s1", "idle-timeout");
    // The session stays alive: no state was lost, so nothing may be released.
    assert.equal(record.state, "idle");
    assert.equal(manager.getState("s1"), "idle");
    assert.deepEqual(hooks.calls, ["persist"]);
    assert.match(record.lastError ?? "", /persist failed/);
  });

  it("surfaces a release failure but still sleeps (state is already persisted)", async () => {
    const hooks: SleepHooks = {
      persist: () => {},
      release: () => { throw new Error("browser busy"); },
      restore: () => {},
    };
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now, hooks: { s1: hooks } });
    manager.markIdle("s1");
    const record = await manager.sleep("s1", "idle-timeout");
    assert.equal(record.state, "sleeping");
    assert.match(record.lastError ?? "", /release failed/);
  });

  it("wakes on a new user message and restores released resources", async () => {
    const hooks = recordingHooks();
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now, hooks: { s1: hooks } });
    manager.markIdle("s1");
    await manager.sleep("s1", "idle-timeout");
    assert.deepEqual(hooks.calls, ["persist", "release"]);
    assert.ok(manager.getRecord("s1")?.snapshot);

    const record = await manager.onUserMessage("s1");
    assert.deepEqual(hooks.calls, ["persist", "release", "restore"]);
    assert.equal(record.state, "active");
    assert.equal(manager.getState("s1"), "active");
    assert.equal(manager.isSleeping("s1"), false);
    // The snapshot is consumed by the wake.
    assert.equal(manager.getRecord("s1")?.snapshot, undefined);
    assert.ok(record.wokeAt !== undefined);
  });

  it("waking restores exactly the snapshot that was persisted", async () => {
    const restored: string[] = [];
    const hooks: SleepHooks = {
      persist: () => {},
      release: () => {},
      restore: (snapshot) => { restored.push(snapshot.persistedAt); },
    };
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now, hooks: { s1: hooks } });
    manager.markIdle("s1");
    await manager.sleep("s1", "idle-timeout");
    const persistedAt = manager.getRecord("s1")?.snapshot?.persistedAt;
    assert.ok(persistedAt);
    await manager.onUserMessage("s1");
    assert.deepEqual(restored, [persistedAt]);
  });

  it("agent activity cancels the pending sleep timer", async () => {
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now });
    manager.markIdle("s1");
    clock.advance(29 * 60_000);
    manager.markActive("s1"); // user came back before the threshold
    clock.advance(60 * 60_000);
    assert.equal(manager.getState("s1"), "active");
    assert.deepEqual(await manager.sweep(), []);
  });

  it("is idempotent: sleeping twice releases once", async () => {
    const hooks = recordingHooks();
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now, hooks: { s1: hooks } });
    manager.markIdle("s1");
    await manager.sleep("s1", "idle-timeout");
    await manager.sleep("s1", "idle-timeout");
    assert.deepEqual(hooks.calls, ["persist", "release"]);
    assert.equal(manager.getRecord("s1")?.sleeps, 1);
  });

  it("reports the remaining time before sleep", () => {
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now });
    manager.markIdle("s1");
    assert.equal(manager.msUntilSleep("s1"), 30 * 60_000);
    clock.advance(5 * 60_000);
    assert.equal(manager.msUntilSleep("s1"), 25 * 60_000);
    assert.equal(manager.msUntilSleep("unknown"), undefined);
  });

  it("emits state changes with the transition reason", async () => {
    const seen: Array<{ state: string; reason: string }> = [];
    manager = new SessionSleepManager({
      idleMinutes: 30,
      now: clock.now,
      onStateChange: (record, reason) => seen.push({ state: record.state, reason }),
    });
    manager.markIdle("s1");
    await manager.sleep("s1", "idle-timeout");
    await manager.onUserMessage("s1");
    assert.deepEqual(seen.map((s) => s.state), ["idle", "sleeping", "awake", "active"]);
    assert.equal(seen[1]?.reason, "idle-timeout");
  });

  it("forget drops the record and its timer", async () => {
    manager = new SessionSleepManager({ idleMinutes: 30, now: clock.now });
    manager.markIdle("s1");
    manager.forget("s1");
    assert.equal(manager.getRecord("s1"), undefined);
    clock.advance(60 * 60_000);
    assert.deepEqual(await manager.sweep(), []);
  });
});
