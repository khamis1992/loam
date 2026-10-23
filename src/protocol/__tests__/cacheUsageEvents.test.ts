import assert from "node:assert";
import { describe, it } from "node:test";

import { createEventMapperState, mapAgentEvent } from "../events.js";
import type { AgentEvent } from "../../agent/events.js";
import type { CacheUsageEvent, ChatEvent } from "../types.js";

function asCacheEvent(event: ChatEvent): CacheUsageEvent {
  assert.equal(event.type, "cache_usage");
  return event as CacheUsageEvent;
}

describe("cache_usage protocol mapping", () => {
  const state = createEventMapperState();

  it("maps provider cache telemetry without replaying assistant text", () => {
    const miss = {
      reason: "provider_switch",
      expectedTokens: 118_000,
      readTokens: 0,
      missedTokens: 118_000,
      message: "KV cache miss [provider_switch]: ~118K tokens resent (provider switched openai-api -> openrouter).",
    };
    const event: AgentEvent = {
      type: "cache_usage",
      provider: "openai-api",
      model: "gpt-5.4",
      promptTokens: 120_000,
      cachedTokens: 0,
      miss,
    };

    const [chatEvent] = mapAgentEvent(event, state, "sess_1");
    assert.ok(chatEvent, "expected one mapped event");
    const cacheUsage = asCacheEvent(chatEvent);
    assert.equal(cacheUsage.provider, "openai-api");
    assert.equal(cacheUsage.model, "gpt-5.4");
    assert.equal(cacheUsage.promptTokens, 120_000);
    assert.equal(cacheUsage.cachedTokens, 0);
    assert.deepEqual(cacheUsage.miss, miss);
    assert.equal(state.assistantBubbleTarget, undefined);
    assert.equal(state.runningTool.size, 0);
  });

  it("maps a warm request without a miss", () => {
    const event: AgentEvent = {
      type: "cache_usage",
      provider: "anthropic",
      model: "claude-opus",
      promptTokens: 30_000,
      cachedTokens: 24_000,
    };

    const [chatEvent] = mapAgentEvent(event, state, "sess_1");
    assert.ok(chatEvent, "expected one mapped event");
    const cacheUsage = asCacheEvent(chatEvent);
    assert.equal(cacheUsage.cachedTokens, 24_000);
    assert.equal(cacheUsage.miss, undefined);
  });
});
