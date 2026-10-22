import type { ChatMessage } from "../ollama.js";

/** Preserve user constraints even when old assistant prose is no longer useful.
 * Keep chronological roles so later user corrections supersede earlier ones.
 * Never silently discard user instructions to fit the context budget. */
export function conversationHistory(messages: ReadonlyArray<{ role: string; content: string }>): ChatMessage[] {
  const turns = messages.filter(m => m.role === "user" || m.role === "assistant");
  const recentStart = Math.max(0, turns.length - 12);
  const selected = turns.filter((m, i) => m.role === "user" || i >= recentStart);
  const omitted = turns.length - selected.length;
  const notice: ChatMessage = { role: "assistant", content: "[History context: older assistant replies were omitted to limit context size. All prior user messages and the most recent 12 conversation messages are retained in chronological order. Do not infer omitted facts or claim to remember omitted outputs; inspect the actual saved artifacts if they matter. Later user corrections take precedence over earlier instructions.]" };
  const chars = selected.reduce((sum, m) => sum + m.content.length, 0) + (omitted ? notice.content.length : 0);
  if (chars > 96_000) throw new Error("Conversation context exceeds 96000 characters while preserving user constraints. Start a new task with the current requirements and relevant artifacts; earlier instructions were not silently discarded.");
  return [...(omitted ? [notice] : []), ...selected.map(m => ({ role: m.role as "user" | "assistant", content: m.content }))];
}
