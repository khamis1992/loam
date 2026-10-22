import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  JsonCooldownStore,
  chatWithFailover,
  classifyFailure,
  parseHumanRetrySeconds,
  parseRetryAfterSeconds,
  providerKey,
  type CooldownEntry,
  type CooldownStore,
  type FailureInput,
  type FailoverProvider,
  type ProviderClient,
} from "../failover.js";
import { CancelledError } from "../../server/runControl.js";
import type { ChatOptions, ChatResult } from "../../ollama.js";

const AUTH_COOLDOWN_MS = 5 * 60_000;
const BILLING_COOLDOWN_MS = 60 * 60_000;
const TRANSIENT_COOLDOWN_MS = 60_000;
const BACKOFF_CAP_MS = 4 * 60 * 60_000;

let tmpDir = "";
let seq = 0;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-failover-"));
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function tempFile(): string {
  seq += 1;
  return path.join(tmpDir, `cooldown-${seq}.json`);
}

function providers(overrides: Partial<FailoverProvider>[] = []): FailoverProvider[] {
  const base: FailoverProvider[] = [
    { id: "a", kind: "ollama", baseUrl: "http://a", model: "m-a", apiKeyEnv: "", enabled: true },
    { id: "b", kind: "openai-compatible", baseUrl: "http://b/v1", model: "m-b", apiKeyEnv: "B_KEY", enabled: true },
    { id: "c", kind: "openai-compatible", baseUrl: "http://c/v1", model: "m-c", apiKeyEnv: "C_KEY", enabled: true },
  ];
  for (const override of overrides) {
    const index = base.findIndex((p) => p.id === override.id);
    if (index >= 0) base[index] = { ...base[index]!, ...override };
  }
  return base;
}

const ENV = { B_KEY: "b-key", C_KEY: "c-key" };

const CHAT: ChatOptions = { model: "ignored", messages: [{ role: "user", content: "hi" }] };

function okResult(provider: string): ChatResult {
  return {
    content: `from ${provider}`,
    toolCalls: [],
    model: provider,
    usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
  };
}

function httpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message);
  err.name = "ProviderHttpError";
  return Object.assign(err, { status });
}

interface Harness {
  createClient: (provider: FailoverProvider) => ProviderClient;
  calls: string[];
}

function harness(behaviors: Record<string, () => Promise<ChatResult>>): Harness {
  const calls: string[] = [];
  return {
    calls,
    createClient: (provider) => ({
      async chat() {
        calls.push(provider.id);
        const behavior = behaviors[provider.id];
        if (!behavior) throw new Error(`unexpected provider ${provider.id}`);
        return behavior();
      },
    }),
  };
}

describe("failover error classification", () => {
  const cases: Array<[FailureInput, number, boolean, string]> = [
    [{ status: 401 }, AUTH_COOLDOWN_MS, false, "auth"],
    [{ status: 403 }, AUTH_COOLDOWN_MS, false, "auth"],
    [{ status: 429 }, TRANSIENT_COOLDOWN_MS, false, "rate limit"],
    [{ status: 429, headers: { "retry-after": "30" } }, 30_000, false, "rate limit"],
    [{ status: 429, headers: { "x-ratelimit-reset": "120" } }, 120_000, false, "rate limit"],
    [{ status: 429, message: "try again in 45s" }, 45_000, false, "rate limit"],
    [{ status: 402 }, BILLING_COOLDOWN_MS, false, "billing"],
    [{ status: 500 }, TRANSIENT_COOLDOWN_MS, false, "transient"],
    [{ status: 503 }, TRANSIENT_COOLDOWN_MS, false, "transient"],
    [{ status: 400 }, 0, true, "request/model"],
    [{ status: 404, message: "model not found" }, 0, true, "request/model"],
  ];

  for (const [input, cooldownMs, skipSession, label] of cases) {
    it(`classifies ${label} ${JSON.stringify(input.status ?? input.message)}`, () => {
      const result = classifyFailure(input);
      assert.equal(result.cooldownMs, cooldownMs);
      assert.equal(result.skipSession, skipSession);
      assert.ok(result.reason.includes(label), `reason "${result.reason}" should include "${label}"`);
    });
  }

  it("classifies from a message when no status is present", () => {
    assert.equal(classifyFailure({ message: "cloud /chat/completions HTTP 401: unauthorized" }).cooldownMs, AUTH_COOLDOWN_MS);
    assert.equal(classifyFailure({ message: "cloud /chat/completions HTTP 429: slow down" }).cooldownMs, TRANSIENT_COOLDOWN_MS);
    assert.equal(classifyFailure({ message: "cloud /api/chat HTTP 400: context length exceeded" }).skipSession, true);
    assert.equal(classifyFailure({ name: "TypeError", message: "fetch failed" }).cooldownMs, TRANSIENT_COOLDOWN_MS);
  });
});

describe("Retry-After parsing", () => {
  it("parses delta-seconds, HTTP-date and epoch seconds", () => {
    assert.equal(parseRetryAfterSeconds("30"), 30);
    assert.equal(parseRetryAfterSeconds(" 120 "), 120);
    assert.equal(parseRetryAfterSeconds(""), undefined);
    assert.equal(parseRetryAfterSeconds(null), undefined);

    const now = Date.now();
    const date = new Date(now + 60_000).toUTCString();
    assert.ok(Math.abs(parseRetryAfterSeconds(date, now)! - 60) < 1);

    const epoch = Math.floor(now / 1000) + 90;
    assert.ok(Math.abs(parseRetryAfterSeconds(String(epoch), now)! - 90) < 1);
  });

  it("parses human retry phrases", () => {
    assert.equal(parseHumanRetrySeconds("try again in 1m30s"), 90);
    assert.equal(parseHumanRetrySeconds("retry after 45 seconds"), 45);
    assert.equal(parseHumanRetrySeconds("rate limited for 2 minutes"), 120);
    assert.equal(parseHumanRetrySeconds("try again in 10"), 10);
    assert.equal(parseHumanRetrySeconds("no timing here"), undefined);
  });
});

describe("exponential backoff cap", () => {
  it("grows 60s*2^n and caps at 4h", () => {
    let previous = 0;
    for (let n = 0; n <= 10; n++) {
      const cooldown = classifyFailure({ status: 429 }, n).cooldownMs;
      assert.ok(cooldown >= previous, "backoff must be non-decreasing");
      assert.ok(cooldown <= BACKOFF_CAP_MS, "backoff must not exceed the cap");
      if (n >= 8) assert.equal(cooldown, BACKOFF_CAP_MS);
      previous = cooldown;
    }
    assert.equal(classifyFailure({ status: 429 }, 100).cooldownMs, BACKOFF_CAP_MS);
    assert.equal(classifyFailure({ status: 429 }, 0).cooldownMs, 60_000);
  });

  it("honors Retry-After even when a backoff count is present", () => {
    const result = classifyFailure({ status: 429, headers: { "retry-after": "15" } }, 9);
    assert.equal(result.cooldownMs, 15_000);
  });
});

describe("provider chain walk", () => {
  it("fails over to the next provider and arms a cooldown", async () => {
    const store = new JsonCooldownStore(tempFile());
    const h = harness({
      a: async () => {
        throw httpError(401, "cloud /chat/completions HTTP 401: unauthorized");
      },
      b: async () => okResult("b"),
    });
    const lines: string[] = [];

    const result = await chatWithFailover({
      providers: providers(),
      chat: CHAT,
      store,
      env: ENV,
      createClient: h.createClient,
      onFailover: (line) => lines.push(line),
    });

    assert.equal(result.content, "from b");
    assert.deepEqual(h.calls, ["a", "b"]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^failover: a -> b \(auth \(401\)\)$/);
    const entry = store.get(providerKey(providers()[0]!));
    assert.ok(entry, "provider a should be cooled down");
    assert.ok(Math.abs(entry!.expiresAt - Date.now() - AUTH_COOLDOWN_MS) < 5_000);
  });

  it("skips a provider for the session on a 400 without a cooldown", async () => {
    const store = new JsonCooldownStore(tempFile());
    const h = harness({
      a: async () => {
        throw httpError(400, "ollama /api/chat HTTP 400: context length exceeded");
      },
      b: async () => okResult("b"),
    });

    const result = await chatWithFailover({
      providers: providers(),
      chat: CHAT,
      store,
      env: ENV,
      createClient: h.createClient,
    });

    assert.equal(result.content, "from b");
    assert.deepEqual(h.calls, ["a", "b"]);
    assert.equal(store.get(providerKey(providers()[0]!)), undefined);
  });

  it("returns the first healthy provider without touching the rest", async () => {
    const store = new JsonCooldownStore(tempFile());
    const h = harness({ a: async () => okResult("a") });

    const result = await chatWithFailover({
      providers: providers(),
      chat: CHAT,
      store,
      env: ENV,
      createClient: h.createClient,
    });

    assert.equal(result.content, "from a");
    assert.deepEqual(h.calls, ["a"]);
  });

  it("starts again at the top on each request, skipping cooled entries", async () => {
    const store = new JsonCooldownStore(tempFile());
    const a = providers()[0]!;
    store.set(providerKey(a), { expiresAt: Date.now() + 60_000, backoffCount: 1 });
    const h = harness({ b: async () => okResult("b") });

    const result = await chatWithFailover({
      providers: providers(),
      chat: CHAT,
      store,
      env: ENV,
      createClient: h.createClient,
    });

    assert.equal(result.content, "from b");
    assert.deepEqual(h.calls, ["b"]);
  });

  it("respects an aborted signal and never retries", async () => {
    const store = new JsonCooldownStore(tempFile());
    const h = harness({
      a: async () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      },
      b: async () => okResult("b"),
    });

    await assert.rejects(
      chatWithFailover({
        providers: providers(),
        chat: { ...CHAT, signal: AbortSignal.abort() },
        store,
        env: ENV,
        createClient: h.createClient,
      }),
      (err: unknown) => err instanceof CancelledError,
    );
    assert.deepEqual(h.calls, ["a"]);
  });

  it("ignores disabled and keyless providers", async () => {
    const store = new JsonCooldownStore(tempFile());
    const h = harness({ c: async () => okResult("c") });
    const chain = providers([
      { id: "a", enabled: false },
      { id: "b", enabled: false },
    ]);

    const result = await chatWithFailover({
      providers: chain,
      chat: CHAT,
      store,
      env: ENV,
      createClient: h.createClient,
    });

    assert.equal(result.content, "from c");
    assert.deepEqual(h.calls, ["c"]);
  });
});

describe("cooldown persistence", () => {
  it("round-trips live entries and drops expired ones", () => {
    const file = tempFile();
    const writer = new JsonCooldownStore(file);
    writer.set("a:m-a", { expiresAt: Date.now() + 60_000, backoffCount: 3 });
    writer.set("old:m-old", { expiresAt: Date.now() - 1, backoffCount: 5 });
    writer.save();

    const reader = new JsonCooldownStore(file);
    assert.equal(reader.get("a:m-a")?.backoffCount, 3);
    assert.equal(reader.get("old:m-old"), undefined);

    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, CooldownEntry>;
    assert.equal(parsed["a:m-a"]!.backoffCount, 3);
    assert.equal(parsed["old:m-old"], undefined);
  });

  it("writes atomically and tolerates a missing file", () => {
    const file = tempFile();
    const store = new JsonCooldownStore(file);
    store.save();
    assert.ok(fs.existsSync(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), {});
  });
});

describe("all-cooled behavior", () => {
  it("throws an aggregated error when every provider is cooled beyond 60s", async () => {
    const store = new JsonCooldownStore(tempFile());
    const chain = providers();
    const now = Date.now();
    for (const p of chain) store.set(providerKey(p), { expiresAt: now + 300_000, backoffCount: 1 });
    const h = harness({ a: async () => okResult("a") });

    await assert.rejects(
      chatWithFailover({ providers: chain, chat: CHAT, store, env: ENV, createClient: h.createClient }),
      /All providers failed or cooled: a: cooled; b: cooled; c: cooled/,
    );
    assert.deepEqual(h.calls, []);
  });

  it("waits for the soonest cooldown when it expires within 60s, then retries from the top", async () => {
    const store = new JsonCooldownStore(tempFile());
    const chain = providers();
    let current = 1_000_000;
    store.set(providerKey(chain[0]!), { expiresAt: current + 30_000, backoffCount: 1 });
    store.set(providerKey(chain[1]!), { expiresAt: current + 300_000, backoffCount: 1 });
    store.set(providerKey(chain[2]!), { expiresAt: current + 300_000, backoffCount: 1 });
    const h = harness({ a: async () => okResult("a") });
    const slept: number[] = [];

    const result = await chatWithFailover({
      providers: chain,
      chat: CHAT,
      store,
      env: ENV,
      createClient: h.createClient,
      now: () => current,
      sleep: async (ms) => {
        slept.push(ms);
        current += ms;
      },
    });

    assert.equal(result.content, "from a");
    assert.deepEqual(h.calls, ["a"]);
    assert.equal(slept.length, 1);
    assert.ok(slept[0]! <= 30_000 && slept[0]! > 0);
  });
});

describe("fetch integration", () => {
  it("arms a cooldown from a Retry-After header via the real client", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "120" },
      })) as unknown as typeof fetch;
    try {
      const store = new JsonCooldownStore(tempFile());
      const chain: FailoverProvider[] = [
        { id: "cloud", kind: "openai-compatible", baseUrl: "http://cloud/v1", model: "m", apiKeyEnv: "CLOUD_KEY", enabled: true },
      ];

      await assert.rejects(
        chatWithFailover({ providers: chain, chat: CHAT, store, env: { CLOUD_KEY: "k" } }),
        /All providers failed or cooled/,
      );

      const entry = store.get(providerKey(chain[0]!));
      assert.ok(entry);
      assert.ok(Math.abs(entry!.expiresAt - Date.now() - 120_000) < 5_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("store helper", () => {
  it("exposes live entries", () => {
    const store: CooldownStore = new JsonCooldownStore(tempFile());
    store.set("a:m-a", { expiresAt: Date.now() + 1000, backoffCount: 2 });
    assert.equal(store.entries().length, 1);
  });
});
