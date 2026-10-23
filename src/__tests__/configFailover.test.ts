/**
 * C19 — failover provider base URLs must match the real provider endpoints.
 *
 * The defaults in `src/config.ts` are the only place Loam hard-codes remote
 * provider endpoints, and they were guessed once and never verified: failover
 * calls silently went to hosts that do not serve the documented API. These
 * assertions pin the documented endpoints and refuse regressions in three
 * directions:
 *
 *   1. the longcat entry points at the documented OpenAI-compatible base URL;
 *   2. every *enabled* provider carries a syntactically valid URL with no
 *      trailing slash (a trailing slash produces `//chat/completions`);
 *   3. no provider entry can smuggle a key value into the repo — only the
 *      `apiKeyEnv` *name* is allowed.
 *
 * Run: node --import tsx --test src/__tests__/configFailover.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS } from "../config.js";
import type { FailoverProvider } from "../llm/failover.js";

const providers = DEFAULTS.failover?.providers ?? [];

function byId(id: string): FailoverProvider {
  const found = providers.find((p) => p.id === id);
  assert.ok(found, `expected a failover provider named "${id}"`);
  return found!;
}

/** True when the value is an absolute http(s) URL that `new URL` accepts. */
function isHttpUrl(value: string): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

test("longcat uses the documented OpenAI-compatible base URL", () => {
  assert.equal(byId("longcat").baseUrl, "https://api.longcat.chat/openai/v1");
});

test("every enabled provider has a valid URL with no trailing slash", () => {
  const enabled = providers.filter((p) => p.enabled);
  assert.ok(enabled.length > 0, "expected at least one enabled failover provider");
  for (const p of enabled) {
    assert.ok(isHttpUrl(p.baseUrl), `${p.id}: baseUrl is not a valid http(s) URL: ${JSON.stringify(p.baseUrl)}`);
    assert.ok(!p.baseUrl.endsWith("/"), `${p.id}: baseUrl must not end with a slash: ${JSON.stringify(p.baseUrl)}`);
  }
});

test("providers never embed an API key value", () => {
  // Only the *name* of the environment variable may appear; the key value itself
  // must never be committed.
  const envName = /^[A-Z][A-Z0-9_]*$/;
  // Empty is legitimate: local (ollama-kind) providers need no credential. A
  // non-empty value must be an env-var *name*, never the key itself.
  for (const p of providers) {
    assert.ok(
      p.apiKeyEnv.length === 0 || envName.test(p.apiKeyEnv),
      `${p.id}: apiKeyEnv must be an env-var name (or empty), got ${JSON.stringify(p.apiKeyEnv)}`,
    );
  }

  // Every string in a provider entry, other than the credential field, must be
  // an identifier or a URL - never a high-entropy token.
  const keyLike = /^[A-Za-z0-9_-]{24,}$/;
  for (const p of providers) {
    for (const [field, value] of Object.entries(p)) {
      if (field === "apiKeyEnv") continue;
      if (typeof value !== "string") continue;
      if (isHttpUrl(value)) continue;
      assert.ok(
        !keyLike.test(value),
        `${p.id}: suspicious key-like value in ${field}: ${JSON.stringify(value)}`,
      );
    }
  }
});
