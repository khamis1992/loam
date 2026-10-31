/**
 * OpenAI-compatible protocol adapter.
 * 
 * Used by: OpenAI, OpenRouter, LongCat, LM Studio, llama.cpp server, etc.
 * Endpoints: POST /chat/completions, GET /models
 */

import type { ProviderAdapter, AdapterOptions, ChatOptions, ChatResult } from "./types.js";

export class OpenAICompatAdapter implements ProviderAdapter {
  constructor(private options: AdapterOptions) {}

  async chat(options: ChatOptions): Promise<ChatResult> {
    // TODO Phase 3b: Implement OpenAI SSE format (data: {...}\n\n)
    // - POST /v1/chat/completions
    // - Authorization: Bearer <apiKey>
    // - Request: { model, messages, tools?, temperature, stream: true }
    // - SSE format: data: {...}\n\ndata: [DONE]\n\n
    // - Response chunks: { choices[].delta.content, .tool_calls }
    // - Usage: { prompt_tokens, completion_tokens }
    
    throw new Error("OpenAI-compatible adapter not yet implemented (Phase 3b)");
  }

  async listModels() {
    // TODO Phase 3b: Implement GET /v1/models
    return [];
  }
}
