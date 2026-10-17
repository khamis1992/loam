import type { ChatMessage } from "../ollama.js";

/** Copy persisted turns before appending the current request. Keep roles intact. */
export function conversationHistory(messages: ReadonlyArray<{ role: string; content: string }>): ChatMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}
