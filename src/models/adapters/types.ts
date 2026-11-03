/**
 * Common types for protocol adapters.
 * 
 * Adapters translate between Loam's internal ChatOptions/ChatResult format
 * and each provider's native API (Ollama, OpenAI, Anthropic, Gemini).
 */

import type { ChatMessage, ChatOptions, ChatResult, OllamaToolCall } from "../../ollama.js";

/**
 * Adapter interface: one implementation per protocol kind.
 * 
 * Each adapter handles streaming SSE parsing, tool calling, and error
 * classification for its protocol family.
 */
export interface ProviderAdapter {
  /**
   * Execute a chat completion.
   * 
   * @param options - Chat request options
   * @param onChunk - Streaming callback (called for each SSE event)
   * @returns Promise<ChatResult>
   */
  chat(options: ChatOptions, onChunk?: (chunk: string) => void): Promise<ChatResult>;

  /**
   * List available models from the provider.
   * 
   * @returns Promise<DiscoveredModel[]>
   */
  listModels?(): Promise<Array<{
    remoteId: string;
    label?: string;
    contextWindow?: number;
    vision?: boolean;
    tools?: boolean;
  }>>;
}

/**
 * Adapter factory options.
 * 
 * Injected when creating an adapter instance.
 */
export interface AdapterOptions {
  /** Base URL (without trailing slash) */
  baseUrl: string;
  /** API key (if auth required) */
  apiKey?: string;
  /** Custom auth header name (e.g. "x-api-key", "x-goog-api-key") */
  authHeader?: string;
  /** Extra headers (e.g. x-opencode-session UUID) */
  extraHeaders?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Common adapter error codes (mapped from HTTP status + provider semantics).
 */
export type AdapterErrorCode =
  | "unreachable" // Network error, DNS failure, connection refused
  | "timeout" // Request exceeded timeout
  | "auth" // 401 Unauthorized, 403 Forbidden
  | "billing" // 402 Payment Required
  | "rate_limited" // 429 Too Many Requests
  | "not_found" // 404 Not Found (endpoint or model)
  | "bad_request" // 400-499 client error
  | "bad_response" // 500-599 server error, or unparseable response
  | "model_not_found" // Model ID not recognized
  | "unknown"; // Unclassified

/**
 * Adapter error with classified code and optional retry-after.
 */
export interface AdapterError {
  code: AdapterErrorCode;
  message: string;
  status?: number;
  retryAfterSec?: number;
}

// Re-export Loam's internal types for adapter implementations
export type { ChatMessage, ChatOptions, ChatResult, OllamaToolCall as ToolCall };
