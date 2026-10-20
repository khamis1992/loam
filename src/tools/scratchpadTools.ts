import { getTask } from "../server/db.js";
import {
  addScratchpadItem,
  completeScratchpadItem,
  listScratchpadItems,
  type ScratchpadStatus,
} from "../server/scratchpad.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

const DEFAULT_BUCKET = "default";

function agentIdFromContext(ctx: ToolContext): string {
  if (!ctx.taskId) return DEFAULT_BUCKET;
  const task = getTask(ctx.taskId);
  return task?.agentId ?? DEFAULT_BUCKET;
}

function formatItem(item: { id: string; text: string; status: string; createdAt: string; doneAt?: string }): string {
  const state = item.status === "done" ? "[done]" : "[open]";
  const done = item.doneAt ? ` (done at ${item.doneAt})` : "";
  return `${state} ${item.id}: ${item.text}${done}`;
}

export function createScratchpadTools(): Tool[] {
  return [
    {
      name: "scratchpad_add",
      description:
        "Add a short to-do item to this agent's scratchpad. Use it to track sub-tasks the agent needs to remember across turns.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "One-line task text" } },
        required: ["text"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const text = str(args, "text").trim();
        if (!text) return { ok: false, content: "scratchpad_add requires non-empty text" };
        const agentId = agentIdFromContext(ctx);
        try {
          const item = addScratchpadItem(agentId, text);
          return { ok: true, content: `added scratchpad item ${item.id} for agent ${agentId}: ${item.text}` };
        } catch (err) {
          return { ok: false, content: `scratchpad_add failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "scratchpad_list",
      description:
        "List this agent's scratchpad items. Open items are returned first, then completed items, newest first. Optionally filter by status 'open' or 'done'.",
      parameters: {
        type: "object",
        properties: { status: { type: "string", enum: ["open", "done"], description: "Optional status filter" } },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const agentId = agentIdFromContext(ctx);
        const status = str(args, "status") as ScratchpadStatus | "";
        const filter = status === "open" || status === "done" ? status : undefined;
        const items = listScratchpadItems(agentId, filter);
        if (items.length === 0) return { ok: true, content: "(no scratchpad items)" };
        return { ok: true, content: items.map(formatItem).join("\n") };
      },
    },
    {
      name: "scratchpad_complete",
      description: "Mark a scratchpad item as done by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Scratchpad item id" } },
        required: ["id"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const id = str(args, "id").trim();
        if (!id) return { ok: false, content: "scratchpad_complete requires id" };
        const agentId = agentIdFromContext(ctx);
        const item = completeScratchpadItem(agentId, id);
        if (!item) return { ok: false, content: `scratchpad item ${id} not found or already completed for agent ${agentId}` };
        return { ok: true, content: `completed scratchpad item ${item.id}: ${item.text}` };
      },
    },
  ];
}
