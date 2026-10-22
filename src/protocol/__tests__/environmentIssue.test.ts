/**
 * D17: an environment-issue report must survive both live streaming and history
 * replay.
 *
 *  - `mapAgentEvent` turns the agent's `environment_issue` event into an
 *    `environmentIssue` chat event (the card the UI renders).
 *  - `buildHistoryFromTask` rebuilds that card from a persisted task step, so
 *    reopening the session shows the same report instead of dropping it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapAgentEvent, createEventMapperState } from "../index.js";
import { buildHistoryFromTask } from "../socket.js";
import type { Task } from "../../server/db.js";

describe("environment_issue event mapping", () => {
  it("maps the agent event to an environmentIssue chat event", () => {
    const out = mapAgentEvent(
      { type: "environment_issue", message: "npm ci failed: no network", details: "ENOTFOUND registry.npmjs.org" },
      createEventMapperState(),
      "s1",
    );

    assert.equal(out.length, 1);
    const issue = out[0]!;
    assert.equal(issue.type, "environmentIssue");
    assert.equal(issue.message, "npm ci failed: no network");
    assert.equal(issue.details, "ENOTFOUND registry.npmjs.org");
  });

  it("omits details when the agent supplies none", () => {
    const out = mapAgentEvent({ type: "environment_issue", message: "toolchain missing" }, createEventMapperState(), "s1");
    assert.equal(out[0]!.type, "environmentIssue");
    assert.equal((out[0] as { details?: string }).details, undefined);
  });

  it("replays the card from a persisted task step", () => {
    const task = {
      id: "t1",
      title: "task",
      status: "done",
      createdAt: new Date().toISOString(),
      messages: [],
      steps: [
        {
          at: new Date().toISOString(),
          type: "environment_issue",
          data: { type: "environment_issue", message: "python3 not found on PATH", details: "which python3: not found" },
        },
      ],
    } as unknown as Task;

    const history = buildHistoryFromTask(task, "s1");
    const issue = history.find((e) => e.type === "environmentIssue");
    assert.ok(issue, "the persisted environment-issue step must render as a card");
    assert.equal(issue.message, "python3 not found on PATH");
    assert.equal(issue.details, "which python3: not found");
  });
});
