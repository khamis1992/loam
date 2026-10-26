import type { ChatMessage, ChatResult } from "../../ollama.js";

export interface LegalModelRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  format?: Record<string, unknown>;
}

export type LegalModelPort = (req: LegalModelRequest) => Promise<ChatResult>;
