import type { ChatMessage, ChatResult } from "../../ollama.js";

export interface LegalModelRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type LegalModelPort = (req: LegalModelRequest) => Promise<ChatResult>;
