/**
 * D12: managed child sessions (coordinator/children).
 *
 * Covers the acceptance criteria: budget_exceeded, message delivery, exactly-once
 * finish wake, needs_input surfacing, and terminate.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";
import type { ManagedChildEvent, ManagedSessionRegistry } from "../managedSessions.js";

let tmpDir = "";
let registry: ManagedSessionRegistry;
let closeDb: () => void;
let dbApi: { getSchedule: (id: string) => { id: string; agentId?: string; enabled: boolean } | undefined };

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("managed sessions (D12)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-managed-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = (await import("../sqliteStore.js")) as unknown as { closeDb: () => void };
    closeDb = sqlite.closeDb;
    dbApi = (await import("../db.js")) as unknown as typeof dbApi;
    const mod = (await import("../managedSessions.js")) as unknown as { ManagedSessionRegistry: new () => ManagedSessionRegistry };
    registry = new mod.ManagedSessionRegistry();
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("a child exceeding its step budget stops with status budget_exceeded", async () => {
    const child = registry.start({
      parentAgentId: "agent_p1",
      childAgentId: "agent_c1",
      prompt: "work",
      budget: { maxSteps: 2 },
      runner: async (ctx) => {
        ctx.reportStep();
        ctx.reportStep();
        ctx.reportStep();
        return "never reached";
      },
    });

    const finished = await registry.waitFinished(child.id);
    assert.equal(finished.status, "budget_exceeded");
    assert.equal(finished.steps, 3);
    assert.match(finished.error ?? "", /steps budget/);
  });

  it("a child exceeding its token budget stops with status budget_exceeded", async () => {
    const child = registry.start({
      parentAgentId: "agent_p1",
      childAgentId: "agent_c1",
      prompt: "work",
      budget: { maxTokens: 10 },
      runner: async (ctx) => {
        ctx.reportTokens(4);
        ctx.reportTokens(4);
        ctx.reportTokens(4);
        return "never reached";
      },
    });

    const finished = await registry.waitFinished(child.id);
    assert.equal(finished.status, "budget_exceeded");
    assert.match(finished.error ?? "", /tokens budget/);
  });

  it("a child exceeding its time budget stops with status budget_exceeded", async () => {
    const child = registry.start({
      parentAgentId: "agent_p1",
      childAgentId: "agent_c1",
      prompt: "work",
      budget: { timeoutMs: 30 },
      runner: (ctx) => new Promise<string>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });

    const finished = await registry.waitFinished(child.id);
    assert.equal(finished.status, "budget_exceeded");
    assert.match(finished.error ?? "", /time budget/);
  });

  it("delivers a message to a running child", async () => {
    const received: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const child = registry.start({
      parentAgentId: "agent_p2",
      childAgentId: "agent_c2",
      prompt: "work",
      runner: async (ctx) => {
        await gate;
        received.push(...ctx.consumeMessages());
        return "done";
      },
    });

    assert.equal(registry.message(child.id, "hello child"), true);
    release();
    const finished = await registry.waitFinished(child.id);
    assert.equal(finished.status, "done");
    assert.deepEqual(received, ["hello child"]);
  });

  it("wakes the coordinator exactly once when a child finishes", async () => {
    let finishCount = 0;
    let last: ManagedChildEvent | undefined;
    const off = registry.onCoordinatorWake("agent_p3", (event) => {
      if (event.type === "finish") {
        finishCount += 1;
        last = event;
      }
    });

    const child = registry.start({
      parentAgentId: "agent_p3",
      childAgentId: "agent_c3",
      prompt: "work",
      runner: async () => "the child answer",
    });

    const finished = await registry.waitFinished(child.id);
    assert.equal(finished.status, "done");
    assert.equal(finishCount, 1, "finish must wake the coordinator exactly once");
    assert.equal(last?.childId, child.id);
    assert.equal(last?.status, "done");
    assert.equal(last?.output, "the child answer");

    // Terminating after the child already finished must not wake again.
    assert.equal(registry.terminate(child.id), false);
    assert.equal(finishCount, 1);
    off();
  });

  it("surfaces a child question through a needs_input event", async () => {
    const events: ManagedChildEvent[] = [];
    const off = registry.onCoordinatorWake("agent_p4", (event) => events.push(event));

    const child = registry.start({
      parentAgentId: "agent_p4",
      childAgentId: "agent_c4",
      prompt: "work",
      runner: async (ctx) => {
        const answer = await ctx.requestInput("Which file should I edit?");
        return `answered: ${answer}`;
      },
    });

    await waitFor(() => events.some((e) => e.type === "needs_input"));
    const need = events.find((e) => e.type === "needs_input");
    assert.ok(need, "a needs_input event must be emitted");
    assert.equal(need?.childId, child.id);
    assert.equal(need?.question, "Which file should I edit?");
    assert.equal(registry.pendingQuestion(child.id), "Which file should I edit?");

    assert.equal(registry.answerInput(child.id, "src/index.ts"), true);
    const finished = await registry.waitFinished(child.id);
    assert.equal(finished.status, "done");
    assert.equal(finished.output, "answered: src/index.ts");
    off();
  });

  it("terminate stops a running child", async () => {
    const child = registry.start({
      parentAgentId: "agent_p5",
      childAgentId: "agent_c5",
      prompt: "work",
      runner: (ctx) => new Promise<string>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });

    assert.equal(registry.terminate(child.id), true);
    const finished = await registry.waitFinished(child.id);
    assert.equal(finished.status, "terminated");
    assert.match(finished.error ?? "", /terminated/);
    assert.equal(registry.terminate(child.id), false, "a finished child cannot be terminated again");
  });

  it("sleep and wake move a child between states", async () => {
    const child = registry.start({
      parentAgentId: "agent_p6",
      childAgentId: "agent_c6",
      prompt: "work",
      runner: async () => "done",
    });
    assert.equal(registry.sleep(child.id), true);
    assert.equal(registry.get(child.id)?.status, "sleeping");
    assert.equal(registry.wake(child.id), true);
    assert.equal(registry.get(child.id)?.status, "running");
    await registry.waitFinished(child.id);
  });

  it("schedules a one-shot self reminder bound to the coordinator", () => {
    const { id } = registry.scheduleSelfReminder("agent_p7", new Date(Date.now() + 60_000).toISOString(), "check the build");
    const schedule = dbApi.getSchedule(id);
    assert.ok(schedule, "the reminder schedule must be persisted");
    assert.equal(schedule?.agentId, "agent_p7");
    assert.equal(schedule?.enabled, true);
  });
});
