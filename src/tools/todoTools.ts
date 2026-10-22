/**
 * The `todo_write` tool: the model's live task list.
 *
 * The list is replaced in full on every call, so the model always sends the
 * complete state rather than a delta. Exactly one item may be `in_progress`,
 * which keeps the model honest about what it is doing right now and gives the
 * harness a single, unambiguous "current step" for reminders and the UI.
 *
 * The tool emits a `todo` event that the protocol maps to a `todoUpdate`
 * socket event, so the UI renders the same list the model is tracking.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import type { TodoItem, TodoStatus } from "../agent/events.js";

/** The only statuses a todo item may carry. */
export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/** Upper bound on the list length, so a runaway model cannot flood the UI. */
export const MAX_TODO_ITEMS = 50;

export interface ParsedTodoItem {
  content: string;
  status: TodoStatus;
}

/** Parse and validate the raw `todos` argument. Returns the first error found. */
export function parseTodoItems(raw: unknown): { items: ParsedTodoItem[]; error?: string } {
  if (!Array.isArray(raw)) return { items: [], error: "todos must be an array" };
  if (raw.length === 0) return { items: [], error: "todos must contain at least one item" };
  if (raw.length > MAX_TODO_ITEMS) {
    return { items: [], error: `todos must contain at most ${MAX_TODO_ITEMS} items` };
  }

  const items: ParsedTodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { items: [], error: "each todo item must be an object with content and status" };
    }
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) return { items: [], error: "each todo item requires a non-empty content" };

    const status = record.status;
    if (typeof status !== "string" || !TODO_STATUSES.includes(status as TodoStatus)) {
      return {
        items: [],
        error: `todo item "${content}" has invalid status ${JSON.stringify(status)}; expected one of ${TODO_STATUSES.join(", ")}`,
      };
    }
    items.push({ content, status: status as TodoStatus });
  }
  return { items };
}

/** Build the `todo_write` tool. */
export function todoWriteTool(): Tool {
  return {
    name: "todo_write",
    description:
      "Maintain the live task list for this run. Pass the complete, updated list every time: the new list replaces the previous one in full, so never send a partial delta. " +
      "Break the work into a small number of concrete, verifiable steps. Mark a step completed the moment you have evidence it is done, keep at most one step in progress, and add any newly discovered work as a new step. " +
      "Send an updated list frequently — before starting work, immediately after finishing a step, and whenever the plan changes — so the list never goes stale on a multi-step task.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TODO_ITEMS,
          description: "The complete task list. This replaces any previous list in full.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "status"],
            properties: {
              content: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                description: "One concrete, verifiable step.",
              },
              status: {
                type: "string",
                enum: [...TODO_STATUSES],
                description:
                  "pending: not started; in_progress: the single step being worked on now; completed: finished and verified.",
              },
            },
          },
        },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const { items, error } = parseTodoItems(args.todos);
      if (error) return { ok: false, content: error };

      const inProgress = items.filter((item) => item.status === "in_progress");
      if (inProgress.length > 1) {
        return {
          ok: false,
          content: `at most one todo may be in_progress (found ${inProgress.length}: ${inProgress.map((item) => item.content).join("; ")})`,
        };
      }

      const todos: TodoItem[] = items.map((item, index) => ({
        id: `todo-${index}`,
        content: item.content,
        status: item.status,
      }));
      ctx.emit({ type: "todo", todos, source: "model" });

      const completed = items.filter((item) => item.status === "completed").length;
      const parts = [`${completed}/${items.length} completed`];
      if (inProgress.length > 0) parts.push(`in progress: ${inProgress[0]!.content}`);
      return { ok: true, content: parts.join("; ") };
    },
  };
}

/** Build the todo tool set. */
export function createTodoTools(): Tool[] {
  return [todoWriteTool()];
}
