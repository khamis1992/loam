/**
 * Secret redaction for logs, errors, and API responses.
 * 
 * Prevents API keys from leaking into:
 * - Log files (console.log, log.warn, etc.)
 * - HTTP response bodies (/api/model-registry/*)
 * - Error messages shown to users
 * - Test snapshots
 * - Git commits
 * 
 * Patterns match common key formats. Known secrets are also replaced explicitly.
 */

/**
 * Regex patterns for common API key formats.
 * 
 * Matched case-insensitively where applicable:
 * - OpenAI/Anthropic: sk-...
 * - Bearer tokens
 * - x-api-key headers
 * - Google AI: AIza...
 * - FreeLLMAPI: freellmapi-...
 */
const PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic API keys
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Bearer tokens
  /x-api-key["':\s]+[A-Za-z0-9._-]{8,}/gi, // x-api-key headers
  /AIza[0-9A-Za-z_-]{30,}/g, // Google AI API keys
  /freellmapi-[A-Za-z0-9_-]{8,}/g, // FreeLLMAPI keys
];

/**
 * Redact secrets from text.
 * 
 * Replaces:
 * 1. Known secret values (passed explicitly)
 * 2. Pattern matches (common key formats)
 * 
 * Short strings (<6 chars) are never blanked, as they're unlikely to be secrets
 * and may cause false positives (e.g. "Bearer" as a word).
 * 
 * @param text - Text to redact (error message, log line, API response)
 * @param known - Array of known secret values to replace
 * @returns Text with secrets replaced by "«redacted»"
 */
export function redactSecrets(text: string, known: string[] = []): string {
  let result = text;

  // Replace known secrets first (exact string match)
  for (const secret of known) {
    if (secret && secret.length >= 6) {
      // Split and join is faster than replaceAll for multiple occurrences
      result = result.split(secret).join("«redacted»");
    }
  }

  // Replace pattern matches
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, "«redacted»");
  }

  return result;
}

/**
 * Redact secrets from an object (for JSON responses).
 * 
 * Recursively walks the object and redacts string values.
 * Does NOT mutate the input; returns a new object.
 * 
 * @param obj - Object to redact
 * @param known - Array of known secret values
 * @returns New object with redacted strings
 */
export function redactSecretsFromObject(obj: unknown, known: string[] = []): unknown {
  if (typeof obj === "string") {
    return redactSecrets(obj, known);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecretsFromObject(item, known));
  }

  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactSecretsFromObject(value, known);
    }
    return result;
  }

  return obj;
}
