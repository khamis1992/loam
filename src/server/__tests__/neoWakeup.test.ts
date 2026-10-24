/**
 * Neo N8 acceptance tests:
 * - schedule_wakeup / cancel_wakeup tools
 * - recurring wakeups with until cap
 * - round subtrees on run graph
 * - approval-gated email notifications
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-neo-n8-test-"));
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import { nextOccurrenceAfter, initialNextRunAt } from "../scheduleTime.js";
import { addSchedule, dueSchedules, getSchedule, listSchedules, recordScheduleOutcome } from "../db.js";
import { createWakeupTools } from "../../tools/wakeupTools.js";
import { RunGraph } from "../../graph/runGraph.js";
import { createApproval, decideApproval, getApproval } from "../approvals.js";
import { sendRoundEmailWithApproval } from "../roundNotifications.js";
import { createBinding, startChannelRouter } from "../channels/router.js";
import { createAgent } from "../agents.js";
import { EmailChannel, MockEmailProvider } from "../channels/email.js";

describe("Neo N8: agent-initiated recurring wakeups", () => {
  it("stops recurring runs once 'until' boundary is exceeded", () => {
    const timing = {
      intervalSeconds: 60,
      until: "2026-10-20T10:05:00.000Z",
    };
    const t0 = new Date("2026-10-20T10:00:00.000Z");
    const next1 = nextOccurrenceAfter(timing, t0);
    assert.ok(next1);
    assert.equal(next1, "2026-10-20T10:01:00.000Z");

    // At 10:04:30 + 60s -> 10:05:30, which is > 10:05:00 (until), so returns null!
    const t4 = new Date("2026-10-20T10:04:30.000Z");
    const next5 = nextOccurrenceAfter(timing, t4);
    assert.equal(next5, null, "occurrence past until must return null");

    // Advance beyond until
    const tPast = new Date("2026-10-20T10:05:00.000Z");
    const nextAfterUntil = nextOccurrenceAfter(timing, tPast);
    assert.equal(nextAfterUntil, null, "occurrence after until should return null to stop schedule");
  });

  it("increments round count on schedule outcome advance", () => {
    const s = addSchedule(
      "recurring task",
      300,
      "agent-test",
      "loam",
      "cron",
      undefined,
      true,
      {
        cron: "0 * * * *",
        timezone: "Asia/Qatar",
        missionId: "task-root-1",
        round: 1,
      }
    );
    assert.equal(s.round, 1);
    assert.equal(s.missionId, "task-root-1");

    // Record outcome ok
    const updated = recordScheduleOutcome(s.id, { ok: true, taskId: "run-round-1" });
    assert.ok(updated);
    assert.equal(updated.round, 2, "round should increment from 1 to 2");

    const fetched = getSchedule(s.id);
    assert.equal(fetched?.round, 2);
  });

  it("schedule_wakeup tool registers a schedule with round=1 and emits event", async () => {
    const events: any[] = [];
    const ctx: any = {
      taskId: "mission-99",
      agentId: "agent-watcher",
      workMode: "loam",
      emit: (ev: any) => events.push(ev),
    };
    const tools = createWakeupTools();
    const schedTool = tools.find((t) => t.name === "schedule_wakeup");
    assert.ok(schedTool);

    const res = await schedTool.run({
      intervalSeconds: 60,
      instruction: "Check deployment status",
      until: "2026-12-31T23:59:59.000Z",
    }, ctx);
    assert.ok(res.ok);
    assert.ok(res.content.includes("Wake-up scheduled successfully with ID '"));
    const match = /ID '([^']+)'/.exec(res.content);
    assert.ok(match && match[1]);
    const scheduleId = match[1];
    const sched = getSchedule(scheduleId);
    assert.ok(sched);
    assert.equal(sched.missionId, "mission-99");
    assert.equal(sched.round, 1);

    const emitted = events.find((e) => e.type === "wakeup_scheduled");
    assert.ok(emitted);
    assert.equal(emitted.scheduleId, scheduleId);
  });

  it("cancel_wakeup tool cancels by scheduleId or defaults to missionId", async () => {
    const events: any[] = [];
    const ctx: any = {
      taskId: "mission-cancel-test",
      agentId: "agent-watcher",
      workMode: "loam",
      emit: (ev: any) => events.push(ev),
    };
    const tools = createWakeupTools();
    const schedTool = tools.find((t) => t.name === "schedule_wakeup")!;
    const cancelTool = tools.find((t) => t.name === "cancel_wakeup")!;

    const r1 = await schedTool.run({ intervalSeconds: 120 }, ctx);
    const match = /ID '([^']+)'/.exec(r1.content);
    assert.ok(match && match[1]);
    const scheduleId = match[1];

    const cancelRes = await cancelTool.run({ scheduleId }, ctx);
    assert.ok(cancelRes.ok);
    assert.equal(getSchedule(scheduleId), undefined, "schedule should be deleted");

    const cancelEv = events.find((e) => e.type === "wakeup_cancelled");
    assert.ok(cancelEv);
  });

  it("runGraph creates round nodes for round_start and updates them on round_done", () => {
    const graph = new RunGraph();
    const runId = "test-run-round-nodes";
    graph.beginRun(runId, "Perform mission");

    graph.applyEvent(runId, {
      type: "round_start",
      round: 1,
      scheduleId: "sched-1",
      prompt: "Execute round 1",
    } as any);

    const store = graph.getStore();
    const nodesAfterStart = store.list({ runId });
    const roundNode = nodesAfterStart.find((n) => n.type === "round");
    assert.ok(roundNode, "round node should exist");
    assert.equal((roundNode.data as any).round, 1);

    graph.applyEvent(runId, {
      type: "round_done",
      round: 1,
      scheduleId: "sched-1",
      summary: "Round 1 finished successfully",
    } as any);

    const updatedNode = store.getNode(roundNode.id, runId);
    assert.ok(updatedNode);
    assert.equal(updatedNode.status, "finished");
    assert.equal((updatedNode.data as any).summary, "Round 1 finished successfully");
  });

  it("sendRoundEmailWithApproval gates notification behind user approval", async () => {
    const provider = new MockEmailProvider();
    const emailChannel = new EmailChannel(provider);
    const stopRouter = startChannelRouter({ channels: [emailChannel] });
    const agent = createAgent({ name: "Mailer Agent" } as any);
    createBinding("email", "ops@example.com", agent.id);

    // Initiate notification in background
    const promise = sendRoundEmailWithApproval({
      taskId: "task-round-notify",
      round: 1,
      agentId: agent.id,
      summary: "All checks passed.",
    });

    // Check that approval was created and is pending
    const approvals = (await import("../approvals.js")).listApprovals();
    const emailApproval = approvals.find((a) => a.taskId === "task-round-notify" && a.tool === "round_email_notification");
    assert.ok(emailApproval, "approval record should be created");
    assert.equal(emailApproval.status, "pending");
    assert.equal(provider.getOutbox().length, 0, "email must not be sent before approval");

    // Approve the request
    decideApproval(emailApproval.id, "approve");

    const res = await promise;
    assert.equal(res.sent, true);
    assert.equal(res.status, "approved");
    const outbox = provider.getOutbox();
    assert.equal(outbox.length, 1, "email should be dispatched upon approval");
    assert.ok(outbox[0]);
    assert.equal(outbox[0].to, "ops@example.com");
    assert.ok(outbox[0].text.includes("Mission Round 1 Completed"));
  });

  /**
   * Acceptance: a mock clock drives an hourly wake-up three times. Each firing
   * starts a new round (a fresh subtree on the run graph), the round completion
   * queues one email notification that waits for the user's approval, and cancelling
   * the wake-up stops any further rounds.
   */
  it("mock clock: hourly wake x3 produces 3 round subtrees and 3 queued emails; cancel stops", async () => {
    const provider = new MockEmailProvider();
    const emailChannel = new EmailChannel(provider);
    const stopRouter = startChannelRouter({ channels: [emailChannel] });
    const agent = createAgent({ name: "Hourly Agent" } as any);
    createBinding("email", "ops-hourly@example.com", agent.id);

    // The mock clock: each round's completion hands the next firing a later instant.
    let clock = new Date("2026-10-20T10:00:00.000Z");
    const schedule = addSchedule(
      "hourly deployment check",
      3600,
      agent.id,
      "loam",
      "cron",
      undefined,
      true,
      {
        cron: "0 * * * *",
        timezone: "Asia/Qatar",
        missionId: "task-hourly",
        round: 1,
      },
    );
    const runId = "run-hourly-mock-clock";
    const graph = new RunGraph();
    graph.beginRun(runId, "hourly deployment check");

    const roundStarts: Array<{ round: number; scheduleId: string; prompt: string }> = [];
    const roundDones: Array<{ round: number; scheduleId: string; summary: string }> = [];
    const emit = (event: any) => {
      if (event.type === "round_start") {
        roundStarts.push(event);
        graph.applyEvent(runId, event as any);
      } else if (event.type === "round_done") {
        roundDones.push(event);
        graph.applyEvent(runId, event as any);
      }
    };

    // Three hourly firings: the scheduler's cadence advances by the cron hour and
    // the round counter increments with each completed round.
    for (let i = 1; i <= 3; i++) {
      assert.equal(schedule.round, i, `schedule should be on round ${i}`);
      assert.ok(schedule.nextRunAt, "schedule should have a next run time");
      // The firing starts the round subtree...
      emit({ type: "round_start", round: schedule.round, scheduleId: schedule.id, prompt: schedule.prompt });
      // ...and the round completion queues its email behind the approval gate.
      emit({ type: "round_done", round: schedule.round, scheduleId: schedule.id, summary: `Round ${schedule.round} finished` });
      const email = await sendRoundEmailWithApproval({
        taskId: "task-hourly",
        round: schedule.round,
        scheduleId: schedule.id,
        agentId: agent.id,
        summary: `Round ${schedule.round} finished`,
      });
      // Nobody has approved yet: the email stays queued, never dispatched.
      assert.equal(email.sent, false);
      assert.equal(email.status, "pending");
      assert.equal(provider.getOutbox().length, 0, "no email may leave before approval");

      // The clock advances past the firing and the round is recorded as done.
      clock = new Date(clock.getTime() + 3600_000);
      recordScheduleOutcome(schedule.id, { ok: true, taskId: `task-round-${i}`, now: clock });
    }

    assert.equal(roundStarts.length, 3);
    assert.equal(roundDones.length, 3);
    assert.deepEqual(
      roundStarts.map((e) => e.round),
      [1, 2, 3],
      "each hourly firing starts the next round",
    );
    assert.deepEqual(
      roundDones.map((e) => e.round),
      [1, 2, 3],
      "each round completes with its own summary",
    );

    // Three round subtrees on the run graph, all finished.
    const roundNodes = graph.getStore().list({ runId }).filter((n) => n.type === "round");
    assert.equal(roundNodes.length, 3, "one subtree per round");
    assert.deepEqual(
      roundNodes.map((n) => (n.data as any).round).sort((a, b) => a - b),
      [1, 2, 3],
    );
    assert.ok(roundNodes.every((n) => n.status === "finished"));

    // Three emails are queued awaiting the user's approval.
    const approvals = (await import("../approvals.js")).listApprovals();
    const roundApprovals = approvals.filter((a) => a.tool === "round_email_notification" && a.taskId === "task-hourly");
    assert.equal(roundApprovals.length, 3, "one queued email per round");

    // Cancelling the wake-up stops further rounds.
    const tools = createWakeupTools();
    const cancelTool = tools.find((t) => t.name === "cancel_wakeup")!;
    const cancelled = await cancelTool.run({ scheduleId: schedule.id }, { taskId: "task-hourly", agentId: agent.id } as any);
    assert.ok(cancelled.ok);
    assert.equal(getSchedule(schedule.id), undefined, "cancelled schedule is gone");
    assert.equal(listSchedules().filter((s) => s.id === schedule.id).length, 0);
    // A schedule that no longer exists can never fire another round.
    assert.equal(dueSchedules().some((s) => s.id === schedule.id), false);

    stopRouter();
  });
});
