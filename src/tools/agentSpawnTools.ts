import { getTask } from "../server/db.js";
import { delegateToChild, listChildren, spawnAgent } from "../server/agentSpawn.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

/** The agent that owns the running task; spawn/delegation are parent-scoped. */
function parentAgentId(ctx: ToolContext): string {
  if (!ctx.taskId) return "";
  return getTask(ctx.taskId)?.agentId ?? "";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAgentSpawnTools(): Tool[] {
  return [
    {
      name: "spawn_agent",
      description:
        "Create a persistent child agent of this agent, or reuse the existing one for the same spawn key. The same spawn key always returns the same child agent, so repeated calls never create duplicates. Use delegate_to_child to run work on the child.",
      parameters: {
        type: "object",
        properties: {
          spawnKey: { type: "string", description: "Stable key identifying the child inside this agent (e.g. 'researcher')." },
          name: { type: "string", description: "Display name of the child agent." },
          instructions: { type: "string", description: "System instructions the child agent follows on every run." },
          description: { type: "string", description: "Short description of what the child is for." },
          emoji: { type: "string", description: "Emoji shown for the child agent." },
          mode: { type: "string", description: "Optional Loam mode for the child (e.g. build, ask, research)." },
        },
        required: ["spawnKey", "name", "instructions"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "spawn_agent requires a parent agent — this run has no agent identity" };
        const spawnKey = str(args, "spawnKey").trim();
        try {
          const res = spawnAgent({
            parentAgentId: parentId,
            spawnKey,
            name: str(args, "name"),
            instructions: str(args, "instructions"),
            description: str(args, "description"),
            emoji: str(args, "emoji"),
            mode: str(args, "mode"),
          });
          return {
            ok: true,
            content: res.created
              ? `spawned child agent ${res.childId} for spawn key "${spawnKey}"`
              : `child agent ${res.childId} already exists for spawn key "${spawnKey}" — reused it`,
          };
        } catch (err) {
          return { ok: false, content: `spawn_agent failed: ${errorText(err)}` };
        }
      },
    },
    {
      name: "delegate_to_child",
      description:
        "Run a request on one of this agent's child agents and wait for its final answer. The child runs under its own identity; the answer is returned to you as the tool result.",
      parameters: {
        type: "object",
        properties: {
          childId: { type: "string", description: "Id of the child agent (see list_children)." },
          prompt: { type: "string", description: "Complete, self-contained request for the child agent." },
          timeoutSeconds: { type: "number", description: "How long to wait for the child (default 300 seconds)." },
        },
        required: ["childId", "prompt"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "delegate_to_child requires a parent agent — this run has no agent identity" };
        const childId = str(args, "childId").trim();
        const prompt = str(args, "prompt").trim();
        const timeoutSeconds = num(args, "timeoutSeconds", 300);
        const res = await delegateToChild(
          { parentAgentId: parentId, childId, prompt, timeoutSeconds },
          ctx.signal ? { signal: ctx.signal } : undefined,
        );
        if (!res.ok) return { ok: false, content: `delegate_to_child failed: ${res.error ?? "child task did not complete"}` };
        return { ok: true, content: res.content || "(the child agent returned no answer)" };
      },
    },
    {
      name: "list_children",
      description: "List the child agents this agent has spawned, with their ids, names and spawn keys.",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "list_children requires a parent agent — this run has no agent identity" };
        const children = listChildren(parentId);
        if (children.length === 0) return { ok: true, content: "(no child agents)" };
        const lines = children.map((c) => `- ${c.emoji} ${c.name} (id ${c.childId}, spawn key "${c.spawnKey}"${c.archived ? ", archived" : ""})`);
        return { ok: true, content: lines.join("\n") };
      },
    },
  ];
}
