/**
 * Protocol tests for the live task list.
 *
 * The `todo_write` tool emits a `todo` agent event; the protocol maps it to a
 * `todoUpdate` socket event the UI renders. These tests exercise the mapper
 * end to end: a tool call, its result, and the resulting list event.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { createEventMapperState, mapAgentEvent } from "../events.js";
import type { ChatEvent, TodoUpdateEvent } from "../types.js";

function mapAll(events: AgentEvent[]): ChatEvent[] {
  const state = createEventMapperState();
  return events.flatMap((event) => mapAgentEvent(event, state, "sess_1"));
}

function todoEvent() {
  return {
    type: "todo" as const,
    source: "model" as const,
    todos: [
      { id: "todo-0", content: "read the spec", status: "completed" as const },
      { id: "todo-1", content: "write the parser", status: "in_progress" as const },
      { id: "todo-2", content: "run the tests", status: "pending" as const },
    ],
  };
}

describe("todo protocol mapping", () => {
  it("maps a todo event to a single todoUpdate carrying the full list", () => {
    const out = mapAll([todoEvent()]);
    const update = out.find((e): e is TodoUpdateEvent => e.type === "todoUpdate");
    assert.ok(update, "expected a todoUpdate event");
    assert.equal(out.filter((e) => e.type === "todoUpdate").length, 1);
    assert.deepEqual(
      update!.todos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
      [
        { id: "todo-0", content: "read the spec", status: "completed" },
        { id: "todo-1", content: "write the parser", status: "in_progress" },
        { id: "todo-2", content: "run the tests", status: "pending" },
      ],
    );
  });

  it("shows the list after a todo_write tool call and result", () => {
    const out = mapAll([
      { type: "tool_call", name: "todo_write", args: { todos: [{ content: "write the parser", status: "in_progress" }] } },
      { type: "tool_result", name: "todo_write", ok: true, summary: "0/1 completed; in progress: write the parser" },
      todoEvent(),
    ]);

    const toolUsed = out.filter((e) => e.type === "toolUsed");
    assert.ok(toolUsed.length >= 2, "expected the tool call and result frames");
    const update = out.find((e): e is TodoUpdateEvent => e.type === "todoUpdate");
    assert.ok(update, "the UI must receive the rendered list");
    assert.equal(update!.todos.length, 3);
  });
});
