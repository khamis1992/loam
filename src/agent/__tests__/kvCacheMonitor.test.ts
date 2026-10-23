/**
 * Unit tests: prompt-cache (KV) usage parsing and miss classification.
 *
 * Mirrors jcode's `kv_cache_monitor.rs` contract: provider usage normalizes to
 * `{promptTokens, cachedTokens}`, a miss is only reported when a meaningful part
 * of the previously reusable prefix was not read back, and every reason carries
 * a specific, human-readable explanation.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  KvCacheMonitor,
  MIN_MISSED_TOKENS,
  OPENAI_MIN_MISSED_TOKENS,
  formatDurationSecs,
  formatTokenCount,
  isHarnessCaused,
  minMissedTokensForProvider,
  missMessage,
  parseAnthropicUsage,
  parseOllamaUsage,
  parseOpenAiUsage,
  parseProviderUsage,
  providerRollsCacheDaily,
  signatureExtends,
  utcDayOf,
  type RequestRoute,
  type RequestSignature,
} from "../kvCacheMonitor.js";

function route(overrides: Partial<RequestRoute> = {}): RequestRoute {
  return { provider: "claude", model: "claude-opus", cacheTtlSecs: 300, ...overrides };
}

function sig(messages: number[], overrides: Partial<RequestSignature> = {}): RequestSignature {
  return {
    systemStaticHash: 1,
    toolsHash: 2,
    toolCount: 3,
    messagesHash: messages.reduce((sum, m) => sum + m, 0),
    messageHashes: messages,
    messageCount: messages.length,
    ...overrides,
  };
}

function warm(monitor: KvCacheMonitor): void {
  monitor.beginRequest(route(), sig([10, 11]));
  assert.equal(monitor.finishRequest(50_000, 0), undefined, "no baseline yet");
}

function openAiRoute(): RequestRoute {
  return { provider: "openai-api", model: "gpt-5.4", cacheTtlSecs: 1800, ttlIsEstimate: true };
}

describe("provider usage parsing", () => {
  it("normalizes OpenAI prompt_tokens_details.cached_tokens", () => {
    assert.deepEqual(parseOpenAiUsage({ prompt_tokens: 12_000, prompt_tokens_details: { cached_tokens: 11_800 } }), {
      promptTokens: 12_000,
      cachedTokens: 11_800,
    });
  });

  it("accepts the legacy top-level cached_tokens shape", () => {
    assert.deepEqual(parseOpenAiUsage({ prompt_tokens: 1_000, cached_tokens: 900 }), {
      promptTokens: 1_000,
      cachedTokens: 900,
    });
  });

  it("never reports a cache read larger than the prompt", () => {
    assert.deepEqual(parseOpenAiUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } }), {
      promptTokens: 100,
      cachedTokens: 100,
    });
  });

  it("treats missing telemetry as zero reads, not a miss", () => {
    assert.deepEqual(parseOpenAiUsage({ prompt_tokens: 5_000 }), { promptTokens: 5_000, cachedTokens: 0 });
    assert.deepEqual(parseOpenAiUsage(undefined), { promptTokens: 0, cachedTokens: 0 });
  });

  it("normalizes Anthropic split accounting into a reusable boundary", () => {
    assert.deepEqual(
      parseAnthropicUsage({ input_tokens: 1_200, cache_read_input_tokens: 9_800, cache_creation_input_tokens: 1_500 }),
      { promptTokens: 12_500, cachedTokens: 9_800, cacheWriteTokens: 1_500, uncachedTokens: 1_200 },
    );
  });

  it("reports no cache telemetry for Ollama", () => {
    assert.deepEqual(parseOllamaUsage({ prompt_eval_count: 3_400, eval_count: 120 }), {
      promptTokens: 3_400,
      cachedTokens: 0,
    });
  });

  it("routes by provider id", () => {
    const raw = { input_tokens: 10, cache_read_input_tokens: 90 };
    assert.deepEqual(parseProviderUsage("anthropic", raw), parseAnthropicUsage(raw));
    assert.deepEqual(parseProviderUsage("claude", raw), parseAnthropicUsage(raw));
    assert.deepEqual(parseProviderUsage("ollama", raw), parseOllamaUsage(raw));
    assert.deepEqual(parseProviderUsage("OpenAI", raw), parseOpenAiUsage(raw));
  });

  it("applies a provider-specific noise floor", () => {
    assert.equal(minMissedTokensForProvider("openai"), OPENAI_MIN_MISSED_TOKENS);
    assert.equal(minMissedTokensForProvider("OpenAI"), OPENAI_MIN_MISSED_TOKENS);
    assert.equal(minMissedTokensForProvider("openai-oauth"), OPENAI_MIN_MISSED_TOKENS);
    assert.equal(minMissedTokensForProvider("claude"), MIN_MISSED_TOKENS);
  });

  it("knows which providers roll their cache at 00:00 UTC", () => {
    assert.equal(providerRollsCacheDaily("anthropic"), true);
    assert.equal(providerRollsCacheDaily("claude"), true);
    assert.equal(providerRollsCacheDaily("openrouter"), false);
  });
});

describe("token and duration formatting", () => {
  it("formats token counts for humans", () => {
    assert.equal(formatTokenCount(987), "987");
    assert.equal(formatTokenCount(1_000), "1K");
    assert.equal(formatTokenCount(4_123), "4.12K");
    assert.equal(formatTokenCount(33_096), "33.1K");
    assert.equal(formatTokenCount(40_000), "40K");
    assert.equal(formatTokenCount(336_400), "336K");
    assert.equal(formatTokenCount(1_250_000), "1.25M");
    assert.equal(formatTokenCount(2_000_000), "2M");
  });

  it("formats compact durations", () => {
    assert.equal(formatDurationSecs(45), "45s");
    assert.equal(formatDurationSecs(120), "2m");
    assert.equal(formatDurationSecs(362), "6m 2s");
    assert.equal(formatDurationSecs(3_600), "1h");
    assert.equal(formatDurationSecs(3_900), "1h 5m");
  });
});

describe("signature extension", () => {
  it("accepts a pure append", () => {
    assert.equal(signatureExtends(sig([10, 11, 12]), sig([10, 11])), true);
  });

  it("rejects a modified earlier message or a shorter transcript", () => {
    assert.equal(signatureExtends(sig([10, 99, 12]), sig([10, 11])), false);
    assert.equal(signatureExtends(sig([10]), sig([10, 11])), false);
  });
});

describe("miss classification", () => {
  it("classifies an account failover with from-to detail", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequest(route({ account: "fox" }), sig([10, 11]));
    monitor.finishRequest(33_096, 33_000);
    monitor.beginRequest(route({ account: "otter" }), sig([10, 11, 12]));
    const miss = monitor.finishRequest(40_204, 0);
    assert.ok(miss, "expected a miss");
    assert.equal(miss.reason, "account_switch");
    assert.equal(isHarnessCaused(miss.reason), false);
    const message = missMessage(miss);
    assert.match(message, /\[account_switch\]/);
    assert.match(message, /fox -> otter/);
    assert.match(message, /~33\.1K tokens/);
  });

  it("explains a zero read and rules out harness causes", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route(), sig([10, 11, 12]));
    const miss = monitor.finishRequest(52_000, 0);
    assert.ok(miss);
    assert.equal(miss.reason, "zero_read");
    assert.match(miss.detail, /read 0 of the 50K-token prefix/);
    assert.match(miss.detail, /TTL 5m/);
    assert.match(miss.detail, /evicted/);
  });

  it("does not report a healthy append", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route(), sig([10, 11, 12]));
    assert.equal(monitor.finishRequest(52_000, 49_800), undefined);
  });

  it("reports a small real loss on a large warm prefix", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequest(route(), sig([10]));
    assert.equal(monitor.finishRequest(617_004, 615_629), undefined);
    monitor.beginRequest(route(), sig([10, 11]));
    const miss = monitor.finishRequest(620_252, 615_222);
    assert.ok(miss, "expected a real 1782-token loss");
    assert.equal(miss.reason, "low_read");
    assert.equal(miss.missedTokens, 1_782);
  });

  it("does not flag OpenAI's tail-block rounding", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequest(openAiRoute(), sig([10]));
    assert.equal(monitor.finishRequest(74_368, 73_344), undefined);
    monitor.beginRequest(openAiRoute(), sig([10, 11]));
    assert.equal(monitor.finishRequest(75_267, 73_344), undefined);
    monitor.beginRequest(openAiRoute(), sig([10, 11, 12]));
    assert.equal(monitor.finishRequest(76_900, 73_344), undefined);
  });

  it("still reports a real OpenAI loss", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequest(openAiRoute(), sig([10]));
    monitor.finishRequest(127_199, 127_000);
    monitor.beginRequest(openAiRoute(), sig([10, 11]));
    const miss = monitor.finishRequest(128_870, 110_208);
    assert.ok(miss, "expected a 16991-token loss");
    assert.equal(miss.reason, "low_read");
  });

  it("treats previous cache creation as reusable but the uncached tail as not", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequest(route(), sig([10]));
    assert.equal(monitor.finishRequest(615_629 + 1_375, 615_629), undefined);
    monitor.beginRequest(route(), sig([10, 11]));
    assert.equal(monitor.finishRequest(617_004 + 3_248, 617_004), undefined);
  });

  it("classifies a modified prefix as a harness miss", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route(), sig([10, 99, 12]));
    const miss = monitor.finishRequest(52_000, 4_000);
    assert.ok(miss);
    assert.equal(miss.reason, "prefix_changed");
    assert.equal(isHarnessCaused(miss.reason), true);
    assert.equal(miss.missedTokens, 46_000);
    assert.match(missMessage(miss), /~46K tokens resent/);
  });

  it("classifies a tool-set change even when the read looks fine", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route(), sig([10, 11, 12], { toolsHash: 7 }));
    const miss = monitor.finishRequest(52_000, 47_000);
    assert.ok(miss);
    assert.equal(miss.reason, "tools_changed");
  });

  it("does not call a model switch harness-caused", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route({ model: "claude-sonnet" }), sig([10, 11, 12]));
    const miss = monitor.finishRequest(52_000, 0);
    assert.ok(miss);
    assert.equal(miss.reason, "model_switch");
    assert.equal(isHarnessCaused(miss.reason), false);
  });

  it("never reports a provider that omitted cache telemetry", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route(), sig([99]));
    assert.equal(monitor.finishRequest(52_000, undefined), undefined);
  });

  it("treats a provider-evidenced compaction as an expected refresh", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequest(route(), sig([10, 11]));
    monitor.finishRequest(216_517, 216_064);
    monitor.beginRequest(route(), sig([10, 11, 12]));
    monitor.noteProviderCompaction();
    const miss = monitor.finishRequest(204_393, 0);
    assert.ok(miss, "expected a refresh");
    assert.equal(miss.reason, "compaction");
    assert.equal(miss.expectedTokens, 216_517);
    assert.equal(miss.readTokens, 0);
    assert.equal(miss.documentedCause, "provider_auto_compaction");
    assert.equal(isHarnessCaused(miss.reason), false);
    assert.ok(missMessage(miss).startsWith("KV cache refresh [provider_auto_compaction]"));
    assert.ok(!missMessage(miss).includes("likely a harness bug"));
    assert.ok(missMessage(miss).includes("rebuilding cache is expected"));
    assert.ok(missMessage(miss).includes("previous reusable prefix ~217K tokens"));
    assert.ok(!missMessage(miss).includes("tokens resent"));

    // Evidence belongs to this response only.
    monitor.beginRequest(route(), sig([10, 11, 12, 13]));
    const next = monitor.finishRequest(205_000, 0);
    assert.ok(next);
    assert.equal(next.reason, "zero_read");
    assert.equal(next.documentedCause, undefined);
  });

  it("does not let compaction hide an independent change", () => {
    const cases: Array<[string, () => { route: RequestRoute; signature: RequestSignature }]> = [
      ["model_switch", () => ({ route: route({ model: "other" }), signature: sig([99]) })],
      ["system_changed", () => ({ route: route(), signature: sig([99], { systemStaticHash: 2 }) })],
      ["tools_changed", () => ({ route: route(), signature: sig([99], { toolsHash: 8 }) })],
    ];
    for (const [expected, build] of cases) {
      const monitor = new KvCacheMonitor();
      warm(monitor);
      const { route: nextRoute, signature } = build();
      monitor.beginRequest(nextRoute, signature);
      monitor.noteProviderCompaction();
      const miss = monitor.finishRequest(20_000, 0);
      assert.ok(miss);
      assert.equal(miss.reason, expected);
    }
  });

  it("does not carry compaction evidence across requests or a reset", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route(), sig([10, 11, 12]));
    monitor.noteProviderCompaction();
    monitor.beginRequest(route(), sig([10, 11, 12]));
    assert.equal(monitor.finishRequest(52_000, 0)?.reason, "zero_read");
    monitor.noteProviderCompaction();
    monitor.reset();
    warm(monitor);
    monitor.beginRequest(route(), sig([10, 11, 12]));
    assert.equal(monitor.finishRequest(52_000, 0)?.reason, "zero_read");
  });

  it("does not report a compaction with no measured loss", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.beginRequest(route(), sig([10, 11, 12]));
    monitor.noteProviderCompaction();
    assert.equal(monitor.finishRequest(52_000, 50_000), undefined);
    monitor.beginRequest(route(), sig([99]));
    monitor.noteProviderCompaction();
    assert.equal(monitor.finishRequest(20_000, undefined), undefined);
  });

  it("drops the baseline on reset", () => {
    const monitor = new KvCacheMonitor();
    warm(monitor);
    monitor.reset();
    monitor.beginRequest(route(), sig([99]));
    assert.equal(monitor.finishRequest(52_000, 0), undefined);
  });

  it("attributes a UTC-midnight straddle to the provider", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequestOnDay(route(), sig([10, 11]), 20_744);
    monitor.finishRequest(621_788, 620_865);
    monitor.beginRequestOnDay(route(), sig([10, 11, 12]), 20_745);
    const miss = monitor.finishRequest(622_773, 31_075);
    assert.ok(miss);
    assert.equal(miss.reason, "daily_rollover");
    assert.equal(isHarnessCaused(miss.reason), false);
    assert.equal(miss.documentedCause, "provider_daily_rollover");
    assert.ok(missMessage(miss).startsWith("KV cache refresh [provider_daily_rollover]"));
  });

  it("keeps harness changes ahead of the daily rollover", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequestOnDay(route(), sig([10, 11]), 1);
    monitor.finishRequest(50_000, 50_000);
    monitor.beginRequestOnDay(route(), sig([10, 99, 12]), 2);
    const miss = monitor.finishRequest(52_000, 2_000);
    assert.ok(miss);
    assert.equal(miss.reason, "prefix_changed");
  });

  it("does not attribute a same-day low read to the rollover", () => {
    const monitor = new KvCacheMonitor();
    monitor.beginRequestOnDay(route(), sig([10, 11]), 5);
    monitor.finishRequest(50_000, 50_000);
    monitor.beginRequestOnDay(route(), sig([10, 11, 12]), 5);
    const miss = monitor.finishRequest(52_000, 2_000);
    assert.ok(miss);
    assert.equal(miss.reason, "low_read");
  });

  it("does not attribute a day change on a non-rolling provider", () => {
    const monitor = new KvCacheMonitor();
    const openrouter = route({ provider: "openrouter" });
    monitor.beginRequestOnDay(openrouter, sig([10, 11]), 5);
    monitor.finishRequest(50_000, 50_000);
    monitor.beginRequestOnDay(openrouter, sig([10, 11, 12]), 6);
    const miss = monitor.finishRequest(52_000, 2_000);
    assert.ok(miss);
    assert.equal(miss.reason, "low_read");
  });

  it("classifies an expired cache from the idle gap and TTL", () => {
    let clock = 1_000_000;
    const monitor = new KvCacheMonitor(() => clock);
    monitor.beginRequest(route({ cacheTtlSecs: 300 }), sig([10, 11]));
    monitor.finishRequest(50_000, 50_000);
    clock += 301_000;
    monitor.beginRequest(route({ cacheTtlSecs: 300 }), sig([10, 11, 12]));
    const miss = monitor.finishRequest(52_000, 1_000);
    assert.ok(miss);
    assert.equal(miss.reason, "expired");
    assert.match(miss.detail, /idle 5m 1s exceeded the 5m cache TTL/);
  });

  it("never treats an estimated TTL as hard expiry", () => {
    let clock = 1_000_000;
    const monitor = new KvCacheMonitor(() => clock);
    monitor.beginRequest(openAiRoute(), sig([10, 11]));
    monitor.finishRequest(50_000, 50_000);
    clock += 10_000_000;
    monitor.beginRequest(openAiRoute(), sig([10, 11, 12]));
    const miss = monitor.finishRequest(52_000, 1_000);
    assert.ok(miss);
    assert.equal(miss.reason, "low_read");
  });
});

describe("utc day boundaries", () => {
  it("computes the UTC calendar day", () => {
    assert.equal(utcDayOf(86_399_000), 0);
    assert.equal(utcDayOf(86_400_000), 1);
    assert.equal(utcDayOf(-1_000), -1);
  });
});

describe("provider route metadata", () => {
  it("routes a cloud model to the remote provider with an estimated TTL", async () => {
    const { providerRouteFor } = await import("../loop.js");
    assert.deepEqual(providerRouteFor("glm-5.3:cloud", undefined), {
      provider: "openai-api",
      model: "glm-5.3",
      cacheTtlSecs: 1_800,
      ttlIsEstimate: true,
    });
  });

  it("routes a local model to ollama with no cache telemetry", async () => {
    const { providerRouteFor } = await import("../loop.js");
    assert.deepEqual(providerRouteFor("llama3", undefined), { provider: "ollama", model: "llama3" });
  });

  it("keeps an echoed cloud model on the remote provider", async () => {
    const { providerRouteFor } = await import("../loop.js");
    // The client asks for `glm-5.3:cloud`; the provider echoes `glm-5.3:flash:cloud`.
    const echoed = providerRouteFor("glm-5.3:flash:cloud", undefined);
    assert.equal(echoed.provider, "openai-api");
    assert.equal(echoed.ttlIsEstimate, true);
  });

  it("honors an explicit provider override", async () => {
    const { providerRouteFor } = await import("../loop.js");
    assert.equal(providerRouteFor("gpt-5.4:cloud", "openrouter").provider, "openrouter");
  });
});
