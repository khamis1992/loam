/**
 * Protocol tests for the Manus-style step grouping.
 *
 * The UI nests tool and status rows under the plan step that owns them. The
 * mapper carries `planStepId` on toolUsed/statusUpdate so the renderer can
 * build that tree; these tests pin the wiring end to end.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { createEventMapperState, mapAgentEvent } from "../events.js";
import type { ChatEvent, NewPlanStepEvent, StatusUpdateEvent, ToolUsedEvent } from "../types.js";

function mapAll(events: AgentEvent[]): ChatEvent[] {
  const state = createEventMapperState();
  return events.flatMap((event) => mapAgentEvent(event, state, "sess_1"));
}

function planStepStart(id: string, title: string): AgentEvent {
  return { type: "plan_step", id, index: 1, total: 1, title, phase: "start" };
}

describe("plan step grouping", () => {
  it("tags tool frames with the open step id", () => {
    const out = mapAll([
      planStepStart("s1", "Write greeting.txt"),
      { type: "tool_call", name: "file_write", args: { path: "greeting.txt", content: "hi" } },
      { type: "tool_result", name: "file_write", ok: true, summary: "wrote 2 bytes" },
    ]);

    const step = out.find((e): e is NewPlanStepEvent => e.type === "newPlanStep");
    assert.ok(step, "expected a newPlanStep event");
    assert.equal(step!.stepId, "s1");

    const tools = out.filter((e): e is ToolUsedEvent => e.type === "toolUsed");
    assert.ok(tools.length >= 2, "expected the tool call and result frames");
    for (const tool of tools) assert.equal(tool.planStepId, "s1", "every tool frame must carry the open step id");
  });

  it("tags status updates with the open step id", () => {
    const out = mapAll([
      planStepStart("s1", "Write greeting.txt"),
      { type: "task-status", status: "waiting" },
    ]);

    const status = out.find((e): e is StatusUpdateEvent => e.type === "statusUpdate");
    assert.ok(status, "expected a statusUpdate event");
    assert.equal(status!.planStepId, "s1");
  });

  it("closes the step id when a new step opens", () => {
    const out = mapAll([
      planStepStart("s1", "First"),
      { type: "tool_call", name: "file_read", args: { path: "a.txt" } },
      planStepStart("s2", "Second"),
      { type: "tool_call", name: "file_read", args: { path: "b.txt" } },
    ]);

    const tools = out.filter((e): e is ToolUsedEvent => e.type === "toolUsed");
    const byStep = new Map<string, number>();
    for (const tool of tools) byStep.set(tool.planStepId!, (byStep.get(tool.planStepId!) ?? 0) + 1);
    assert.equal(byStep.get("s1"), 2, "the first step owns its two frames");
    assert.equal(byStep.get("s2"), 2, "the second step owns its two frames");
  });
});
