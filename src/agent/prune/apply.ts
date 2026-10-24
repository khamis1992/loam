import type { ChatMessage } from "../../ollama.js";
import type { PrunedSink, PruneDecision, ToolPair } from "./types.js";

export const PRUNE_MARKER = (chars: number, tool: string, id: string): string =>
  `[pruned: ${chars} chars of this ${tool} result omitted to save context; call context_recall with id="${id}" or re-run the tool if needed]`;

const UNTRUSTED_OPEN = "[UNTRUSTED EXTERNAL CONTENT from ";
const UNTRUSTED_CLOSE = "\n[/UNTRUSTED EXTERNAL CONTENT]";

/** Head stub for a truncated result; an untrusted wrapper stays intact around it. */
function stub(content: string, headChars: number, marker: string): string {
  if (content.startsWith(UNTRUSTED_OPEN) && content.endsWith(UNTRUSTED_CLOSE)) {
    const nl = content.indexOf("\n");
    if (nl > 0) {
      const open = content.slice(0, nl);
      const inner = content.slice(nl + 1, content.length - UNTRUSTED_CLOSE.length);
      return `${open}\n${inner.slice(0, headChars)}\n${marker}${UNTRUSTED_CLOSE}`;
    }
  }
  return `${content.slice(0, headChars)}\n${marker}`;
}

/**
 * Rules: untouched messages keep their identity; truncate_result replaces the tool
 * message with a head stub; drop_call removes the call entry and its tool message
 * together (an assistant message left with no calls and no content is removed).
 * A tool message is never left without its call. Pinned pairs are never changed.
 */
export function applyDecisions(
  messages: readonly ChatMessage[],
  pairs: readonly ToolPair[],
  decisions: readonly PruneDecision[],
  headChars: number,
  store: PrunedSink,
): ChatMessage[] {
  const byId = new Map(decisions.map(d => [d.id, d]));
  const replaced = new Map<number, ChatMessage>();
  const removedTool = new Set<number>();
  const droppedCalls = new Map<number, Set<number>>();

  for (const p of pairs) {
    const d = byId.get(p.id);
    if (!d || d.action === "keep" || p.pinned || p.toolIndex < 0) continue;
    const toolMsg = messages[p.toolIndex]!;
    if (d.action === "truncate_result") {
      const marker = PRUNE_MARKER(toolMsg.content.length, p.tool, p.id);
      const next = stub(toolMsg.content, Math.max(0, headChars), marker);
      if (next.length >= toolMsg.content.length) continue;
      store.put(p.id, p.tool, toolMsg.content);
      replaced.set(p.toolIndex, { ...toolMsg, content: next });
    } else {
      store.put(p.id, p.tool, toolMsg.content);
      removedTool.add(p.toolIndex);
      let set = droppedCalls.get(p.assistantIndex);
      if (!set) droppedCalls.set(p.assistantIndex, (set = new Set()));
      set.add(p.callIndex);
    }
  }

  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (removedTool.has(i)) continue;
    const dropped = droppedCalls.get(i);
    if (dropped) {
      const calls = (m.tool_calls ?? []).filter((_, ci) => !dropped.has(ci));
      if (calls.length === 0 && m.content.trim() === "") continue;
      const { tool_calls: _omit, ...rest } = m;
      out.push(calls.length ? { ...rest, tool_calls: calls } : rest);
      continue;
    }
    out.push(replaced.get(i) ?? m);
  }
  return out;
}
