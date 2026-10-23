/**
 * Unit tests for the `report_environment_issue` tool (environmentIssueTools.ts).
 *
 * Covers the required invariants:
 *  - a valid report records the issue on the session by emitting the
 *    `environment_issue` event and returns guidance to continue
 *  - optional details are carried on the event and the returned guidance
 *  - an empty/oversized message or oversized details is rejected without emitting
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironmentIssueTools, REPORT_ENVIRONMENT_ISSUE_TOOL } from "../environmentIssueTools.js";
import type { AgentEvent } from "../../agent/events.js";
import type { Tool, ToolContext } from "../registry.js";

const tool = (): Tool => createEnvironmentIssueTools().find((t) => t.name === REPORT_ENVIRONMENT_ISSUE_TOOL)!;

const makeCtx = (emit: (e: AgentEvent) => void): ToolContext => ({
  cfg: { model: "test-model" } as never,
  workspace: "/tmp/task",
  emit,
});

describe("report_environment_issue", () => {
  it("records the issue on the session and returns guidance to continue", async () => {
    const events: AgentEvent[] = [];
    const res = await tool().run({ message: "npm ci failed: no network" }, makeCtx((e) => events.push(e)));

    assert.equal(res.ok, true);
    assert.deepEqual(events, [{ type: "environment_issue", message: "npm ci failed: no network" }]);
    assert.match(res.content, /npm ci failed: no network/);
    assert.match(res.content, /rely on CI/i);
    assert.match(res.content, /skip the local step/i);
    assert.match(res.content, /Do not report the step as passed/i);
  });

  it("carries optional details on the event and the guidance", async () => {
    const events: AgentEvent[] = [];
    const res = await tool().run(
      { message: "toolchain missing", details: "python3 not found on PATH" },
      makeCtx((e) => events.push(e)),
    );

    assert.equal(res.ok, true);
    assert.deepEqual(events, [{ type: "environment_issue", message: "toolchain missing", details: "python3 not found on PATH" }]);
    assert.match(res.content, /python3 not found on PATH/);
  });

  it("rejects an empty or oversized message without emitting", async () => {
    const events: AgentEvent[] = [];
    const ctx = makeCtx((e) => events.push(e));

    const empty = await tool().run({ message: "   " }, ctx);
    assert.equal(empty.ok, false);

    const long = await tool().run({ message: "x".repeat(2001) }, ctx);
    assert.equal(long.ok, false);
    assert.match(long.content, /2000/);
    assert.deepEqual(events, []);
  });

  it("rejects oversized details without emitting", async () => {
    const events: AgentEvent[] = [];
    const res = await tool().run({ message: "ok", details: "d".repeat(4001) }, makeCtx((e) => events.push(e)));
    assert.equal(res.ok, false);
    assert.match(res.content, /4000/);
    assert.deepEqual(events, []);
  });
});
