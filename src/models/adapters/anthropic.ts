/**
 * Anthropic protocol adapter.
 * 
 * Native Anthropic Messages API (not OpenAI-compatible).
 * Endpoints: POST /v1/messages, GET /v1/models
 * Auth: x-api-key header (not Bearer)
 * SSE events: message_start, content_block_delta, message_delta, etc.
 */

import type { ProviderAdapter, AdapterOptions, ChatOptions, ChatResult } from "./types.js";

export class AnthropicAdapter implements ProviderAdapter {
  constructor(private options: AdapterOptions) {}

  async chat(options: ChatOptions, onChunk?: (chunk: string) => void): Promise<ChatResult> {
    // TODO Phase 3b: Implement Anthropic Messages API with SSE
    // - x-api-key auth header
    // - anthropic-version: 2023-06-01 header
    // - Request: { model, messages, tools?, max_tokens, stream: true }
    // - SSE events: message_start, content_block_start, content_block_delta (text_delta, thinking_delta), message_delta
    // - Tool format: content[].type === "tool_use" with input field (not arguments)
    
    throw new Error("Anthropic adapter not yet implemented (Phase 3b)");
  }

  async listModels() {
    // TODO Phase 3b: Implement GET /v1/models
    return [];
  }
}
