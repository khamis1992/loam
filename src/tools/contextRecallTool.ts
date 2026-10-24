/**
 * The `context_recall` tool: hand back a tool result the context pruner
 * dropped from the transcript.
 *
 * The pruner leaves a stub naming an id; the body itself sits in the run's
 * in-memory `PrunedStore`. Recalling it re-wraps the body as untrusted, since
 * it was external tool output the first time round too.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { markUntrusted } from "../policy/riskTier.js";

export function contextRecallTool(): Tool {
  return {
    name: "context_recall",
    description:
      "Recover the full output of an earlier tool result that was pruned from the conversation to save context. " +
      "Pass the id quoted in the `[pruned: ...]` placeholder. Only call it when you actually need the omitted text; " +
      "re-running the original tool is the alternative when the recall reports the id is gone.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "The id from the [pruned: ...] placeholder." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, content: "id is required" };
      if (!ctx.prunedStore) {
        return { ok: false, content: "nothing has been pruned in this run, so there is nothing to recall" };
      }
      const entry = ctx.prunedStore.get(id);
      if (!entry) {
        return {
          ok: false,
          content: `no pruned result with id "${id}" (unknown, evicted, or never stored); re-run the original tool if you still need it`,
        };
      }
      return { ok: true, content: markUntrusted(entry.body, `recalled ${entry.tool} result`) };
    },
  };
}

/** Build the context-recall tool set. */
export function createContextRecallTools(): Tool[] {
  return [contextRecallTool()];
}
