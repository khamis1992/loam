/**
 * Google Gemini protocol adapter.
 * 
 * Native Generative AI API (not OpenAI-compatible).
 * Endpoints: POST /v1beta/models/{model}:streamGenerateContent?alt=sse, GET /v1beta/models
 * Auth: x-goog-api-key header (not Bearer)
 * Model ID: "models/gemini-1.5-pro" or "gemini-1.5-pro" (adapter strips "models/" prefix)
 */

import type { ProviderAdapter, AdapterOptions, ChatOptions, ChatResult } from "./types.js";

export class GeminiAdapter implements ProviderAdapter {
  constructor(private options: AdapterOptions) {}

  async chat(options: ChatOptions, onChunk?: (chunk: string) => void): Promise<ChatResult> {
    // TODO Phase 3b: Implement Gemini streamGenerateContent API with SSE
    // - x-goog-api-key auth header
    // - Request: { contents: [{ role, parts: [{ text }] }], tools?, generationConfig }
    // - SSE format: standard SSE with data: lines
    // - Response: { candidates[].content.parts[] } with text, functionCall, functionResponse
    // - Usage: usageMetadata.promptTokenCount, candidatesTokenCount
    // - Model ID handling: strip "models/" prefix if present
    
    throw new Error("Gemini adapter not yet implemented (Phase 3b)");
  }

  async listModels() {
    // TODO Phase 3b: Implement GET /v1beta/models?pageSize=1000
    return [];
  }
}
