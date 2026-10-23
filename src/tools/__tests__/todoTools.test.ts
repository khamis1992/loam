/**
 * Unit tests for the `todo_write` tool.
 *
 * The tool maintains the model's live task list: it replaces the list in full,
 * allows exactly one `in_progress` item, and emits a `todo` event the UI can
 * render. These tests pin the validation rules and the emitted event shape.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import type { ToolContext } from "../registry.js";
import { MAX_TODO_ITEMS, createTodoTools, parseTodoItems, todoWriteTool } from "../todoTools.js";

function makeCtx(): { ctx: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const ctx = {
    cfg: {},
    workspace: ".",
    emit: (event: AgentEvent) => {
      events.push(event);
    },
  } as unknown as ToolContext;
  return { ctx, events };
}

function todos(...items: Array<{ content: string; status: string }>) {
  return { todos: items };
}

describe("parseTodoItems", () => {
  it("accepts a valid list with one in_progress item", () => {
    const { items, error } = parseTodoItems([
      { content: "read the spec", status: "completed" },
      { content: "write the parser", status: "in_progress" },
      { content: "run the tests", status: "pending" },
    ]);
    assert.equal(error, undefined);
    assert.deepEqual(
      items.map((i) => i.status),
      ["completed", "in_progress", "pending"],
    );
  });

  it("trims item content", () => {
    const { items } = parseTodoItems([{ content: "  spaced  ", status: "pending" }]);
    assert.equal(items[0]?.content, "spaced");
  });

  it("rejects a non-array, an empty list, and an over-long list", () => {
    assert.match(parseTodoItems("nope").error!, /must be an array/);
    assert.match(parseTodoItems([]).error!, /at least one item/);
    const tooMany = Array.from({ length: MAX_TODO_ITEMS + 1 }, () => ({ content: "x", status: "pending" }));
    assert.match(parseTodoItems(tooMany).error!, new RegExp(`at most ${MAX_TODO_ITEMS} items`));
  });

  it("rejects an empty content and an unknown status", () => {
    assert.match(parseTodoItems([{ content: "   ", status: "pending" }]).error!, /non-empty content/);
    assert.match(parseTodoItems([{ content: "x", status: "doing" }]).error!, /invalid status "doing"/);
  });
});

describe("todo_write tool", () => {
  it("is registered under the name the loop watches for staleness", () => {
    const names = createTodoTools().map((t) => t.name);
    assert.deepEqual(names, ["todo_write"]);
    assert.equal(todoWriteTool().name, "todo_write");
  });

  it("rejects two in_progress items", async () => {
    const { ctx, events } = makeCtx();
    const res = await todoWriteTool().run(
      todos(
        { content: "first", status: "in_progress" },
        { content: "second", status: "in_progress" },
      ),
      ctx,
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /at most one todo may be in_progress/);
    assert.deepEqual(events, []);
  });

  it("accepts exactly one in_progress item and reports progress", async () => {
    const { ctx } = makeCtx();
    const res = await todoWriteTool().run(
      todos(
        { content: "done step", status: "completed" },
        { content: "current step", status: "in_progress" },
        { content: "later step", status: "pending" },
      ),
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(res.content, "1/3 completed; in progress: current step");
  });

  it("emits a full-replace todo event with stable ids", async () => {
    const { ctx, events } = makeCtx();
    await todoWriteTool().run(
      todos(
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ),
      ctx,
    );
    const todo = events.find((e) => e.type === "todo");
    assert.ok(todo && todo.type === "todo");
    assert.equal(todo.source, "model");
    assert.deepEqual(
      todo.todos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
      [
        { id: "todo-0", content: "a", status: "completed" },
        { id: "todo-1", content: "b", status: "in_progress" },
      ],
    );
  });

  it("rejects an invalid list without emitting anything", async () => {
    const { ctx, events } = makeCtx();
    const res = await todoWriteTool().run(todos({ content: "x", status: "blocked" }), ctx);
    assert.equal(res.ok, false);
    assert.match(res.content, /invalid status/);
    assert.deepEqual(events, []);
  });
});
