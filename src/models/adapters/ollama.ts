/**
 * Ollama protocol adapter.
 * 
 * Native Ollama API (not OpenAI-compatible).
 * Endpoints: /api/chat, /api/tags, /api/show
 */

import { OllamaClient } from "../../ollama.js";
import type { ProviderAdapter, AdapterOptions, ChatOptions, ChatResult } from "./types.js";

export class OllamaAdapter implements ProviderAdapter {
  private client: OllamaClient;

  constructor(private options: AdapterOptions) {
    // Reuse existing OllamaClient implementation
    this.client = new OllamaClient(options.baseUrl);
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    // Delegate to existing OllamaClient
    // Note: onChunk callback handled differently in OllamaClient (options.onToken)
    return await this.client.chat(options);
  }

  async listModels() {
    const names = await this.client.listLocalModels();
    return names.map((remoteId) => ({ remoteId }));
  }
}
