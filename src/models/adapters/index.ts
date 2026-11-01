/**
 * Adapter factory: creates the appropriate adapter for a provider kind.
 */

import type { ProviderAdapter, AdapterOptions } from "./types.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAICompatAdapter } from "./openaiCompat.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";

/**
 * Create an adapter for the given provider kind.
 * 
 * @param kind - Provider protocol kind
 * @param options - Adapter options
 * @returns ProviderAdapter instance
 */
export function createAdapter(
  kind: "ollama" | "openai-compatible" | "anthropic" | "google-gemini",
  options: AdapterOptions,
): ProviderAdapter {
  switch (kind) {
    case "ollama":
      return new OllamaAdapter(options);
    case "openai-compatible":
      return new OpenAICompatAdapter(options);
    case "anthropic":
      return new AnthropicAdapter(options);
    case "google-gemini":
      return new GeminiAdapter(options);
  }
}

export type { ProviderAdapter, AdapterOptions, AdapterError } from "./types.js";
export { classifyError, createProviderError } from "./errors.js";
