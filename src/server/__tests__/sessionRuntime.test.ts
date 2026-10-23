import assert from "node:assert";
import http from "node:http";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";

import { SessionRuntime, DEFAULT_IDLE_MINUTES } from "../sessionRuntime.js";

class FakeClock {
  nowMs = 5_000_000;
  now = (): number => this.nowMs;
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

function request(server: http.Server, method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> }));
}

/** fetch that tolerates an empty body (the 404 branch writes none). */
async function rawRequest(server: http.Server, method: string, urlPath: string, body?: unknown): Promise<{ status: number; text: string }> {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, text: await res.text() }));
}

describe("session runtime (budget + sleep together)", () => {
  let clock: FakeClock;
  let runtime: SessionRuntime;
  let handleSessionRuntimeRoutes: (req: http.IncomingMessage, res: http.ServerResponse, p: string) => Promise<boolean>;

  before(async () => {
    const routes = await import("../routes/sessionRuntime.js");
    handleSessionRuntimeRoutes = routes.handleSessionRuntimeRoutes;
  });

  beforeEach(() => {
    clock = new FakeClock();
    runtime = new SessionRuntime({ idleMinutes: 30, stepLimit: 10, tokenLimit: 1000, now: clock.now });
  });

  after(() => {
    runtime.close();
  });

  it("defaults the idle threshold to 30 minutes", () => {
    assert.equal(DEFAULT_IDLE_MINUTES, 30);
  });

  it("warns at 80% and stops at 100% of the step budget", () => {
    runtime.markActive("s1");
    for (let i = 0; i < 7; i++) runtime.recordStep("s1");
    assert.equal(runtime.evaluate("s1").action, "allow");
    runtime.recordStep("s1"); // 8/10 = 80%
    const warning = runtime.evaluate("s1");
    assert.equal(warning.action, "warn");
    assert.match((warning as { reason: string }).reason, /80%/);
    assert.equal(runtime.lastWarning("s1"), (warning as { reason: string }).reason);
    assert.equal(runtime.isStoppedOnBudget("s1"), false);

    for (let i = 0; i < 2; i++) runtime.recordStep("s1"); // 10/10 = 100%
    assert.equal(runtime.evaluate("s1").action, "stop");
    assert.equal(runtime.isStoppedOnBudget("s1"), true);
  });

  it("stops on the token budget as well", () => {
    runtime.markActive("s1");
    runtime.recordUsage("s1", 800, 0);
    assert.equal(runtime.evaluate("s1").action, "warn");
    runtime.recordUsage("s1", 200, 0);
    assert.equal(runtime.evaluate("s1").action, "stop");
    assert.equal(runtime.isStoppedOnBudget("s1"), true);
  });

  it("raising the budget clears the stop and resumes the session", () => {
    runtime.markActive("s1");
    for (let i = 0; i < 10; i++) runtime.recordStep("s1");
    assert.equal(runtime.evaluate("s1").action, "stop");

    const result = runtime.raise("s1", { steps: 10 });
    assert.equal(result.ok, true);
    runtime.resumeAfterRaise("s1");
    assert.equal(runtime.isStoppedOnBudget("s1"), false);
    // Usage is preserved: 10/20 = 50%.
    assert.equal(runtime.evaluate("s1").action, "allow");
    const snap = runtime.snapshot("s1");
    assert.equal(snap.budget.steps, 10);
    assert.equal(snap.budget.stepLimit, 20);
    assert.equal(snap.raised, true);
    assert.equal(snap.budget.stopped, false);
  });

  it("refuses an invalid raise", () => {
    runtime.markActive("s1");
    assert.equal(runtime.raise("s1", { steps: 0 }).ok, false);
    assert.equal(runtime.raise("s1", {}).ok, false);
    assert.equal(runtime.getBudget("s1").stepLimit, 10);
  });

  it("sleeps an idle session and wakes it on a user message with state restored", async () => {
    const calls: string[] = [];
    const sleeping = new SessionRuntime({
      idleMinutes: 30,
      stepLimit: 10,
      tokenLimit: 1000,
      now: clock.now,
      hooks: {
        s1: {
          persist: () => { calls.push("persist"); },
          release: () => { calls.push("release"); },
          restore: () => { calls.push("restore"); },
        },
      },
    });
    try {
      sleeping.markActive("s1");
      sleeping.recordStep("s1");
      sleeping.recordUsage("s1", 100, 20);
      sleeping.markIdle("s1");
      assert.equal(sleeping.getSleepState("s1"), "idle");

      clock.advance(30 * 60_000);
      await sleeping.forceSleep("s1", "idle-timeout");
      assert.equal(sleeping.getSleepState("s1"), "sleeping");
      assert.equal(sleeping.sleepSnapshot("s1") !== undefined, true);
      assert.deepEqual(calls, ["persist", "release"]);

      const woke = await sleeping.onUserMessage("s1");
      assert.equal(woke.slept, true);
      assert.equal(woke.state, "active");
      assert.equal(sleeping.getSleepState("s1"), "active");
      assert.deepEqual(calls, ["persist", "release", "restore"]);
      // Budget counters survive the sleep/wake cycle.
      assert.equal(sleeping.getBudget("s1").steps, 1);
      assert.equal(sleeping.snapshot("s1").budget.tokens, 120);
    } finally {
      sleeping.close();
    }
  });

  it("keeps budget counters when the session is woken by activity", async () => {
    const rt = new SessionRuntime({ idleMinutes: 30, now: clock.now, stepLimit: 10, tokenLimit: 1000 });
    try {
      rt.markIdle("s2");
      await rt.forceSleep("s2", "manual");
      assert.equal(rt.getSleepState("s2"), "sleeping");
      rt.markActive("s2");
      // markActive() on a sleeping session wakes it (the wake is synchronous
      // when there is no restore hook), so the state is `awake` immediately.
      assert.equal(rt.getSleepState("s2"), "awake");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(rt.getSleepState("s2"), "awake");
      // Budget counters survive the sleep/wake cycle.
      assert.equal(rt.getBudget("s2").steps, 0);
    } finally {
      rt.close();
    }
  });

  it("snapshots the badge payload with the sleep and budget state", () => {
    runtime.markActive("s1");
    for (let i = 0; i < 8; i++) runtime.recordStep("s1");
    const snap = runtime.snapshot("s1");
    assert.equal(snap.sessionId, "s1");
    assert.equal(snap.state, "active");
    assert.equal(snap.sleeping, false);
    assert.equal(snap.budget.steps, 8);
    assert.equal(snap.budget.stepLimit, 10);
    assert.equal(snap.budget.percent, 80);
    assert.equal(snap.budget.stopped, false);
    assert.equal(snap.budget.warning !== undefined, true);

    runtime.markIdle("s1");
    const idle = runtime.snapshot("s1");
    assert.equal(idle.state, "idle");
    assert.equal(idle.msUntilSleep, 30 * 60_000);
  });

  it("forgets a session entirely", () => {
    runtime.markActive("s1");
    runtime.recordStep("s1");
    runtime.forget("s1");
    assert.equal(runtime.getBudget("s1").steps, 0);
    assert.equal(runtime.snapshot("s1").state, "active");
  });

  describe("HTTP routes", () => {
    let server: http.Server;

    beforeEach(async () => {
      server = http.createServer(async (req, res) => {
        const p = new URL(req.url ?? "/", "http://test").pathname;
        if (await handleSessionRuntimeRoutes(req, res, p)) return;
        res.writeHead(404).end();
      });
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
    });

    afterEach(() => {
      server.closeAllConnections();
      server.close();
    });

    it("returns the runtime state with the defaults", async () => {
      const res = await request(server, "GET", "/api/sessions/s1/runtime");
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.defaults, { idleMinutes: 30, stepLimit: 40, tokenLimit: 500000 });
      const session = res.json.session as { state: string; sleeping: boolean; budget: { steps: number; percent: number } };
      assert.equal(session.state, "active");
      assert.equal(session.sleeping, false);
      assert.equal(session.budget.steps, 0);
      assert.equal(session.budget.percent, 0);
    });

    it("sleeps and wakes over HTTP", async () => {
      const slept = await request(server, "POST", "/api/sessions/s1/sleep");
      assert.equal(slept.status, 200);
      assert.equal((slept.json.session as { state: string }).state, "sleeping");
      const woken = await request(server, "POST", "/api/sessions/s1/wake");
      assert.equal(woken.status, 200);
      assert.equal((woken.json.session as { state: string }).state, "awake");
    });

    it("raises the budget over HTTP and clears the stop", async () => {
      // The routes use the process-wide singleton, which has no step/token
      // ceiling; the raise therefore adds on top of zero.
      const bad = await request(server, "POST", "/api/sessions/s1/budget", {});
      assert.equal(bad.status, 400);
      const badBody = await request(server, "POST", "/api/sessions/s1/budget", { steps: -1 });
      assert.equal(badBody.status, 400);

      const good = await request(server, "POST", "/api/sessions/s1/budget", { steps: 25, tokens: 100000 });
      assert.equal(good.status, 200);
      assert.equal(good.json.raised, true);
      const session = good.json.session as { budget: { stepLimit?: number; tokenLimit?: number } };
      assert.equal(session.budget.stepLimit, 25); // 0 + 25 (singleton has no configured ceiling)
      assert.equal(session.budget.tokenLimit, 100000); // 0 + 100000
      assert.equal(good.json.raised, true);
    });

    it("does not handle unrelated paths", async () => {
      const res = await rawRequest(server, "GET", "/api/tasks");
      assert.equal(res.status, 404);
    });
  });
});
