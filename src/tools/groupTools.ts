/**
 * Group-chat tools (MF9).
 *
 * `handoff_to_agent` is always available so the model can see it in every run,
 * but it only succeeds inside a task started by a group chat: the task must be
 * registered in `group_tasks` and the target must be a member of that group.
 * Recording the handoff is side-effect free until the task finishes; the group
 * poller then starts the next agent's task with the group transcript.
 */
import { recordHandoffForTask } from "../server/groupChats.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

export function createGroupTools(): Tool[] {
  return [
    {
      name: "handoff_to_agent",
      description:
        "Hand the current group-chat conversation to another member of the same group. Only valid inside a task started from a group chat. Call this when the next member should reply or act; include a short note describing what they should do.",
      parameters: {
        type: "object",
        properties: {
          agentName: { type: "string", description: "Exact name (or id) of the target group member" },
          note: { type: "string", description: "Short context for the next agent" },
        },
        required: ["agentName"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const agentName = str(args, "agentName").trim();
        if (!agentName) return { ok: false, content: "handoff_to_agent requires agentName" };
        if (!ctx.taskId) return { ok: false, content: "handoff_to_agent is only available inside a group task." };
        const note = str(args, "note").trim();
        const result = recordHandoffForTask(ctx.taskId, agentName, note);
        if (!result.ok || !result.agent) return { ok: false, content: result.reason ?? "handoff failed" };
        return {
          ok: true,
          content: `Handoff recorded to ${result.agent.name}${note ? `: ${note}` : ""}. They will receive the group transcript after this reply.`,
        };
      },
    },
  ];
}
