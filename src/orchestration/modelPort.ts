/**
 * The one narrow model boundary every Core module calls. In Loam it is built by
 * loamModelPort() (src/orchestration/core.ts) over chatWithFallback.
 */
import type { ChatMessage, ChatResult } from "../ollama.js";

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type ModelPort = (req: ModelRequest) => Promise<ChatResult>;
