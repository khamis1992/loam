/**
 * Shared threat-model tools (Strix `tools/threat_model` parity).
 *
 * The model is scan-scoped and shared: a parent saves it once, every child
 * reads it, and an agent that disproves an assumption amends the model instead
 * of keeping a private version. `get` on an empty model returns the shell so
 * the agent knows what to fill in.
 */
import { formatThreatModel, getThreatModel, saveThreatModel } from "../server/threatModel.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

function taskFor(args: Record<string, unknown>, ctx: ToolContext): string {
  return str(args, "task_id").trim() || ctx.taskId || ctx.agentId || "workspace";
}

const PARAMETERS = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "Task that owns the model. Defaults to the current task." },
    summary: { type: "string", description: "One paragraph: what is being tested and why." },
    actors: {
      type: "array",
      description: "Attackers, with what they can already do (anonymous, authenticated, on-network, local).",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          capability: { type: "string" },
        },
        required: ["name"],
      },
    },
    assets: {
      type: "array",
      description: "Assets that matter, where they live and how critical they are.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          where: { type: "string" },
          criticality: { type: "string", enum: ["critical", "high", "medium", "low"] },
          notes: { type: "string" },
        },
        required: ["name"],
      },
    },
    boundaries: {
      type: "array",
      description: "Trust boundaries crossed between components or roles.",
      items: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" }, notes: { type: "string" } },
        required: ["from", "to"],
      },
    },
    assumptions: { type: "array", items: { type: "string" }, description: "Beliefs that, if wrong, change the risk." },
    notes: { type: "array", items: { type: "string" }, description: "Free notes for the fleet." },
  },
} as const;

export function createThreatModelTools(): Tool[] {
  return [
    {
      name: "threat_model_get",
      description:
        "Read the task's shared threat model (actors, assets, trust boundaries, assumptions). Read it before choosing what to test; children share the parent's model.",
      parameters: { type: "object", properties: { task_id: { type: "string" } } },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        return { ok: true, content: formatThreatModel(getThreatModel(taskFor(args, ctx))) };
      },
    },
    {
      name: "threat_model_save",
      description:
        "Write the task's threat model from scratch: the attacker, the assets worth protecting, the trust boundaries and the assumptions. Replaces the previous document; use threat_model_amend to add to an existing one.",
      parameters: PARAMETERS,
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        const model = saveThreatModel(taskId, args, "replace");
        ctx.emit({ type: "assistant_message", text: `Threat model saved (${model.actors.length} actors, ${model.assets.length} assets, ${model.boundaries.length} boundaries).` });
        return { ok: true, content: formatThreatModel(model) };
      },
    },
    {
      name: "threat_model_amend",
      description:
        "Amend the shared threat model: merge actors/assets/boundaries by name and append assumptions/notes. Use it when testing disproves an assumption or reveals a new surface — never keep a private model.",
      parameters: PARAMETERS,
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        const model = saveThreatModel(taskId, args, "amend");
        ctx.emit({ type: "assistant_message", text: `Threat model amended (${model.actors.length} actors, ${model.assets.length} assets, ${model.boundaries.length} boundaries).` });
        return { ok: true, content: formatThreatModel(model) };
      },
    },
  ];
}
