import type { ChatMessage } from "../../ollama.js";
import type { ToolMeta, ToolPair } from "./types.js";

/**
 * Positional pairing: tool messages carry no call id (ollama.ts ChatMessage), so an
 * assistant message with N tool_calls owns the consecutive role:"tool" messages
 * that follow it, in order. When the counts disagree the ownership is ambiguous and
 * every pair of that assistant message is pinned.
 */
export function collectPairs(
  messages: readonly ChatMessage[],
  meta: ReadonlyMap<ChatMessage, ToolMeta>,
  opts: { protectLead: number; preserveRecent: number; pinnedTools: ReadonlySet<string> },
): ToolPair[] {
  const pairs: ToolPair[] = [];
  const seen = new Set<string>();
  const recentFrom = messages.length - Math.max(0, opts.preserveRecent);
  const callMessages: number[] = [];
  messages.forEach((m, i) => { if (m.role === "assistant" && m.tool_calls?.length) callMessages.push(i); });

  for (let order = 0; order < callMessages.length; order++) {
    const ai = callMessages[order]!;
    const calls = messages[ai]!.tool_calls!;
    let owned = 0;
    while (messages[ai + 1 + owned]?.role === "tool") owned++;
    const mismatch = owned !== calls.length;
    const zonePinned = ai < opts.protectLead || ai + owned >= recentFrom;
    const stepsAgo = callMessages.length - 1 - order;

    for (let ci = 0; ci < calls.length; ci++) {
      const toolIndex = ci < owned ? ai + 1 + ci : -1;
      const toolMsg = toolIndex >= 0 ? messages[toolIndex]! : undefined;
      const m = toolMsg ? meta.get(toolMsg) : undefined;
      const tool = calls[ci]!.function.name;
      let id = m?.callId || `p${ai}_${ci}`;
      if (seen.has(id)) id = `p${ai}_${ci}`;
      seen.add(id);
      let argsJson: string;
      try { argsJson = JSON.stringify(calls[ci]!.function.arguments) ?? ""; } catch { argsJson = ""; }
      pairs.push({
        id,
        assistantIndex: ai,
        callIndex: ci,
        toolIndex,
        tool,
        argsJson,
        resultChars: toolMsg ? toolMsg.content.length : 0,
        ok: m ? m.ok : true,
        ...(m?.path ? { path: m.path } : {}),
        stepsAgo,
        pinned: mismatch || toolIndex < 0 || zonePinned || opts.pinnedTools.has(tool),
      });
    }
  }
  return pairs;
}
