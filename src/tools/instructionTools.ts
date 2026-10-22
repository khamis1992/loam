import { getTask } from "../server/db.js";
import { listVersions, proposeInstructions } from "../server/instructionHistory.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

const DEFAULT_AGENT = "default";

function agentIdFromContext(ctx: ToolContext): string {
  if (!ctx.taskId) return DEFAULT_AGENT;
  const task = getTask(ctx.taskId);
  return task?.agentId ?? DEFAULT_AGENT;
}

export function createInstructionHistoryTools(): Tool[] {
  return [
    {
      name: "propose_instructions_update",
      description:
        "Propose an update to this agent's own system instructions. The change never applies directly; the user must approve or reject it. Include a short reason so the user can review your intent.",
      parameters: {
        type: "object",
        properties: {
          instructions: { type: "string", description: "Full replacement instruction text" },
          reason: { type: "string", description: "Short human-readable reason for the change" },
        },
        required: ["instructions"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const instructions = str(args, "instructions");
        if (!instructions.trim()) return { ok: false, content: "propose_instructions_update requires non-empty instructions" };
        const reason = typeof args.reason === "string" ? args.reason : "";
        const agentId = agentIdFromContext(ctx);
        try {
          const proposal = proposeInstructions(agentId, instructions, reason);
          return {
            ok: true,
            content: `proposed instruction update (id ${proposal.id}, version ${proposal.version}) for agent ${agentId}; pending user approval. Reason: ${reason || "(none given)"}`,
          };
        } catch (err) {
          return { ok: false, content: `propose_instructions_update failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "list_instruction_versions",
      description:
        "List the recorded instruction version history for this agent (proposals and applied versions), newest first.",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const agentId = agentIdFromContext(ctx);
        const versions = listVersions(agentId);
        if (versions.length === 0) return { ok: true, content: "(no instruction versions recorded)" };
        return {
          ok: true,
          content: versions
            .map(
              (v) =>
                `v${v.version} [${v.source}/${v.status}] ${v.id} (${v.createdAt})${v.decidedAt ? ` decided ${v.decidedAt}` : ""}`,
            )
            .join("\n"),
        };
      },
    },
  ];
}
