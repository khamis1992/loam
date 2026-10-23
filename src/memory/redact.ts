/**
 * Secret detection for long-term memory.
 *
 * Memory is persisted to disk and injected into prompts, so anything that looks
 * like a credential must be rejected before it is stored. The patterns are
 * deliberately conservative: they target well-known token formats and explicit
 * `key: value` credential assignments rather than arbitrary long strings.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
  /\bghp_[0-9A-Za-z]{36}\b/, // GitHub personal access token
  /\bgho_[0-9A-Za-z]{36}\b/, // GitHub OAuth token
  /\bgithub_pat_[0-9A-Za-z_]{20,}\b/, // GitHub fine-grained PAT
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, // Slack token
  /\bsk-ant-[0-9A-Za-z_-]{20,}\b/, // Anthropic secret key
  /\bsk-[0-9A-Za-z]{20,}\b/, // OpenAI / generic secret key
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"']{6,}/i,
];

/** Return the source of the first matching secret pattern, or null. */
export function findSecret(text: string): string | null {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  return null;
}

export function containsSecret(text: string): boolean {
  return findSecret(text) !== null;
}

/** Throw when the text looks like it contains a credential. */
export function assertNoSecret(text: string): void {
  const hit = findSecret(text);
  if (hit) throw new Error(`memory text rejected: possible secret (${hit.slice(0, 40)})`);
}

/**
 * The same patterns as global regexes, so a caller can remove *every*
 * occurrence of a credential rather than only testing for the first one.
 */
export const SECRET_PATTERNS_GLOBAL: readonly RegExp[] = SECRET_PATTERNS.map(
  (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
);

/** Replacement marker left behind where a credential was removed. */
export const REDACTED = "[redacted]";

/**
 * Remove every credential-shaped substring from `text`, replacing each match
 * with {@link REDACTED}. `findSecret` only answers "is there one?"; a run export
 * has to be safe to publish, so it needs the removal itself. Matching is done on
 * a copy of the pattern list, so a caller's `lastIndex` can never leak state.
 */
export function stripSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS_GLOBAL) {
    out = out.replace(re, REDACTED);
  }
  return out;
}
