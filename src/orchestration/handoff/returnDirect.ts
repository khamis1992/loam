/**
 * C10: direct return from delegates. When a delegate's report already is the
 * answer, the parent skips the extra model call that only re-words it.
 * Idea from VoltAgent's subagent "bail" (core/src/agent/subagent/index.ts:472-513);
 * own design: only a single-call batch qualifies, and Loam's verifier still
 * runs on the returned text (it never skips verification).
 *
 * Loam today (tools/subagents.ts:248) always returns
 * "[Subagent "<name>" finished in N step(s), M tool call(s)]\n\n<text>"
 * to the parent model, which then spends one more call to answer.
 */
export const RETURN_DIRECT_TOOLS: ReadonlySet<string> = new Set(["delegate_task", "delegate_subagent"]);

export interface BatchResult {
  tool: string;
  ok: boolean;
  content: string;
  /** New optional ToolResult field set by delegate tools. */
  returnDirect?: boolean;
}

const HEADER = /^\[Subagent "[^"\n]{1,120}" finished in \d+ step\(s\), \d+ tool call\(s\)\]\n\n/;

/** Strips the delegate header so the user sees only the report. */
export function stripDelegateHeader(content: string): string {
  return content.replace(HEADER, "");
}

/**
 * Decides whether the loop may end the turn with this batch's result.
 * Returns the final text, or undefined to continue normally.
 */
export function directReturnText(batch: readonly BatchResult[], enabled: boolean): string | undefined {
  if (!enabled || batch.length !== 1) return undefined;
  const only = batch[0] as BatchResult;
  if (!only.ok || !only.returnDirect || !RETURN_DIRECT_TOOLS.has(only.tool)) return undefined;
  const text = stripDelegateHeader(only.content).trim();
  return text.length > 0 ? text : undefined;
}

/** JSON-schema fragment added to delegate_task and delegate_subagent parameters. */
export const RETURN_DIRECT_PARAM = {
  return_direct: {
    type: "boolean",
    description: "Set true when the delegate's report should be sent to the user as-is, with no rewording.",
  },
} as const;
