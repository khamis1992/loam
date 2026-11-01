/**
 * Error classification and retry-after parsing for adapters.
 * 
 * Maps HTTP status codes and provider-specific error shapes to unified
 * AdapterError codes. Parses Retry-After headers (seconds or HTTP-date).
 */

import type { AdapterError, AdapterErrorCode } from "./types.js";

/**
 * Classify an error from a fetch call.
 * 
 * @param error - Error thrown by fetch or response parsing
 * @param response - HTTP response (if available)
 * @returns AdapterError with classified code
 */
export function classifyError(error: unknown, response?: Response): AdapterError {
  // Network/timeout errors (no response)
  if (!response) {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes("timeout") || message.includes("timed out")) {
        return { code: "timeout", message: error.message };
      }
      if (message.includes("aborted")) {
        return { code: "timeout", message: "Request was cancelled" };
      }
      return { code: "unreachable", message: error.message };
    }
    return { code: "unreachable", message: String(error) };
  }

  // HTTP status classification
  const status = response.status;
  const retryAfterSec = parseRetryAfter(response.headers.get("retry-after"));

  if (status === 401 || status === 403) {
    return { code: "auth", message: `Authentication failed (${status})`, status, retryAfterSec };
  }

  if (status === 402) {
    return { code: "billing", message: "Payment required (quota exceeded)", status, retryAfterSec };
  }

  if (status === 429) {
    return { code: "rate_limited", message: "Too many requests", status, retryAfterSec };
  }

  if (status === 404) {
    return { code: "not_found", message: "Endpoint or model not found (404)", status };
  }

  if (status >= 400 && status < 500) {
    return { code: "bad_request", message: `Client error (${status})`, status };
  }

  if (status >= 500) {
    return { code: "bad_response", message: `Server error (${status})`, status, retryAfterSec };
  }

  // Unparseable response (200 OK but invalid body)
  if (error instanceof SyntaxError) {
    return { code: "bad_response", message: "Invalid JSON response", status };
  }

  return { code: "unknown", message: String(error), status };
}

/**
 * Parse Retry-After header value.
 * 
 * Supports both formats:
 * - Retry-After: 120 (seconds as integer)
 * - Retry-After: Wed, 21 Oct 2015 07:28:00 GMT (HTTP-date)
 * 
 * @param value - Retry-After header value
 * @returns Seconds to wait, or undefined if invalid
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  // Try parsing as integer (seconds)
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds > 0) {
    // Clamp to 24 hours (86400 seconds)
    return Math.min(seconds, 86400);
  }

  // Try parsing as HTTP-date
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      const now = Date.now();
      const target = date.getTime();
      const delta = Math.max(0, Math.floor((target - now) / 1000));
      return Math.min(delta, 86400); // Clamp to 24 hours
    }
  } catch {
    // Invalid date format
  }

  return undefined;
}

/**
 * Create an AdapterError from a provider-specific error object.
 * 
 * Providers often return error details in response body:
 * { "error": { "message": "...", "type": "...", "code": "..." } }
 * 
 * @param status - HTTP status code
 * @param body - Parsed response body
 * @param retryAfterSec - Retry-After seconds (from header)
 * @returns AdapterError
 */
export function createProviderError(
  status: number,
  body: unknown,
  retryAfterSec?: number,
): AdapterError {
  let message = `HTTP ${status}`;

  // Extract error message from common provider formats
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    
    // OpenAI/OpenRouter: { error: { message, type, code } }
    if (obj.error && typeof obj.error === "object") {
      const err = obj.error as Record<string, unknown>;
      if (typeof err.message === "string") {
        message = err.message;
      }
    }
    
    // Anthropic: { error: { type, message } }
    // Gemini: { error: { message, code, status } }
    if (typeof obj.message === "string") {
      message = obj.message;
    }
  }

  // Classify by status
  if (status === 401 || status === 403) {
    return { code: "auth", message, status, retryAfterSec };
  }
  if (status === 402) {
    return { code: "billing", message, status, retryAfterSec };
  }
  if (status === 429) {
    return { code: "rate_limited", message, status, retryAfterSec };
  }
  if (status === 404) {
    return { code: "not_found", message, status };
  }
  if (status >= 400 && status < 500) {
    return { code: "bad_request", message, status };
  }
  if (status >= 500) {
    return { code: "bad_response", message, status, retryAfterSec };
  }

  return { code: "unknown", message, status };
}
