// src/appbuilder/redact.ts — secret redaction for logs, errors and reports (MISSING §4.6.3)
const PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,             // OpenAI-style and similar API keys
  /\bxai-[A-Za-z0-9]{20,}\b/g,                       // xAI keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,                 // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                           // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /(authorization:\s*bearer\s+)[^\s"']+/gi,
  /((?:api[_-]?key|token|secret|password)\s*[=:]\s*)["']?[^\s"',;]{6,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (m, keep?: string) => (typeof keep === "string" && m.startsWith(keep) ? `${keep}[redacted]` : "[redacted]"));
  return out;
}
