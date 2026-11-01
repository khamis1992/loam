/**
 * Tests for registry compilation to failover format.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileChain, hasUsableKey, canHandleRequest, getProviderLabel } from "./compile.js";
import type { ModelRegistry } from "./types.js";

const testRegistry: ModelRegistry = {
  version: 1,
  providers: [
    {
      id: "ollama",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      location: "local",
      auth: { type: "none" },
      extraHeaders: {},
      timeoutMs: 600000,
      enabled: true,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      location: "cloud",
      auth: { type: "bearer", credentialId: "550e8400-e29b-41d4-a716-446655440000" },
      extraHeaders: {},
      timeoutMs: 120000,
      enabled: true,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    },
    {
      id: "disabled-provider",
      label: "Disabled",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11435",
      location: "local",
      auth: { type: "none" },
      extraHeaders: {},
      timeoutMs: 600000,
      enabled: false,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    },
  ],
  models: [
    {
      id: "ollama/qwen2.5:14b",
      providerId: "ollama",
      remoteId: "qwen2.5:14b",
      label: "Qwen 2.5 14B",
      capabilities: {
        tools: true,
        vision: false,
        thinking: "none",
        jsonMode: true,
        contextWindow: 32768,
        maxOutputTokens: 8192,
        source: "default",
      },
      defaults: {},
      enabled: true,
      tags: [],
    },
    {
      id: "openrouter/claude-3.5",
      providerId: "openrouter",
      remoteId: "anthropic/claude-3.5-sonnet",
      label: "Claude 3.5 Sonnet",
      capabilities: {
        tools: true,
        vision: true,
        thinking: "toggle",
        jsonMode: true,
        contextWindow: 200000,
        maxOutputTokens: 8192,
        source: "default",
      },
      defaults: {},
      enabled: true,
      tags: [],
    },
    {
      id: "ollama/disabled-model",
      providerId: "ollama",
      remoteId: "disabled-model",
      label: "Disabled Model",
      capabilities: {
        tools: "unknown",
        vision: "unknown",
        thinking: "unknown",
        jsonMode: "unknown",
        contextWindow: null,
        maxOutputTokens: null,
        source: "default",
      },
      defaults: {},
      enabled: false,
      tags: [],
    },
    {
      id: "disabled-provider/model",
      providerId: "disabled-provider",
      remoteId: "model",
      label: "Model on Disabled Provider",
      capabilities: {
        tools: "unknown",
        vision: "unknown",
        thinking: "unknown",
        jsonMode: "unknown",
        contextWindow: null,
        maxOutputTokens: null,
        source: "default",
      },
      defaults: {},
      enabled: true,
      tags: [],
    },
  ],
  chains: [
    {
      id: "default",
      label: "Default",
      modelIds: ["ollama/qwen2.5:14b", "openrouter/claude-3.5", "ollama/disabled-model"],
    },
    {
      id: "coding",
      label: "Coding",
      modelIds: ["openrouter/claude-3.5", "ollama/qwen2.5:14b"],
    },
  ],
  defaultModelId: "ollama/qwen2.5:14b",
  fallbackModelId: "openrouter/claude-3.5",
};

describe("compile", () => {
  it("compiles chain to FailoverProvider format", () => {
    const compiled = compileChain(testRegistry, "default");

    assert.strictEqual(compiled.length, 2); // Disabled model skipped
    const first = compiled[0]!;
    assert.ok(first, "Should have first provider");
    assert.strictEqual(first.id, "ollama/qwen2.5:14b");
    assert.strictEqual(first.kind, "ollama");
    assert.strictEqual(first.baseUrl, "http://127.0.0.1:11434");
    assert.strictEqual(first.model, "qwen2.5:14b"); // remoteId, not full ID
    assert.strictEqual(first.enabled, true);
  });

  it("skips disabled models", () => {
    const compiled = compileChain(testRegistry, "default");
    assert.ok(!compiled.find((p) => p.id === "ollama/disabled-model"));
  });

  it("skips models on disabled providers", () => {
    const compiled = compileChain(testRegistry, "default");
    assert.ok(!compiled.find((p) => p.id === "disabled-provider/model"));
  });

  it("preserves chain order", () => {
    const compiled = compileChain(testRegistry, "coding");
    assert.strictEqual(compiled.length, 2);
    const first = compiled[0]!;
    const second = compiled[1]!;
    assert.ok(first && second, "Should have both providers");
    assert.strictEqual(first.id, "openrouter/claude-3.5");
    assert.strictEqual(second.id, "ollama/qwen2.5:14b");
  });

  it("sets apiKeyEnv only for env auth", () => {
    const compiled = compileChain(testRegistry, "default");
    
    const ollamaProvider = compiled.find((p) => p.id === "ollama/qwen2.5:14b");
    assert.ok(ollamaProvider, "Should find ollama provider");
    assert.strictEqual(ollamaProvider.apiKeyEnv, "");

    const openrouterProvider = compiled.find((p) => p.id === "openrouter/claude-3.5");
    assert.ok(openrouterProvider, "Should find openrouter provider");
    assert.strictEqual(openrouterProvider.apiKeyEnv, ""); // Bearer auth, not env
  });

  it("includes registry references", () => {
    const compiled = compileChain(testRegistry, "default");
    assert.ok(compiled.length > 0, "Should have at least one provider");
    const provider = compiled[0]!;

    assert.strictEqual(provider.registryModelId, "ollama/qwen2.5:14b");
    assert.ok(provider.providerRef);
    assert.ok(provider.modelRef);
    assert.strictEqual(provider.providerRef.id, "ollama");
    assert.strictEqual(provider.modelRef.id, "ollama/qwen2.5:14b");
  });
});

describe("hasUsableKey", () => {
  it("returns true for auth type none", () => {
    const provider = compileChain(testRegistry, "default")[0]!;
    assert.ok(provider, "Should have provider");
    assert.strictEqual(hasUsableKey(provider, {}, {}), true);
  });

  it("returns true for bearer auth with hint", () => {
    const provider = compileChain(testRegistry, "default").find((p) => p.id === "openrouter/claude-3.5");
    assert.ok(provider, "Should find openrouter provider");
    const hints = { "550e8400-e29b-41d4-a716-446655440000": "...1234" };
    assert.strictEqual(hasUsableKey(provider, hints, {}), true);
  });

  it("returns false for bearer auth without hint", () => {
    const provider = compileChain(testRegistry, "default").find((p) => p.id === "openrouter/claude-3.5");
    assert.ok(provider, "Should find openrouter provider");
    assert.strictEqual(hasUsableKey(provider, {}, {}), false);
  });

  it("returns true for env auth with set variable", () => {
    const registry: ModelRegistry = {
      ...testRegistry,
      providers: [
        {
          ...testRegistry.providers[1]!,
          id: "openrouter",
          label: "OpenRouter",
          kind: "openai-compatible",
          baseUrl: "https://openrouter.ai/api/v1",
          location: "cloud",
          auth: { type: "env", envVar: "TEST_KEY" },
          extraHeaders: {},
          timeoutMs: 120000,
          enabled: true,
          createdAt: "2026-10-31T00:00:00Z",
          updatedAt: "2026-10-31T00:00:00Z",
        },
      ],
    };

    const provider = compileChain(registry, "default").find((p) => p.id === "openrouter/claude-3.5");
    assert.ok(provider, "Should find openrouter provider");
    const env = { TEST_KEY: "some-value" };
    assert.strictEqual(hasUsableKey(provider, {}, env), true);
  });

  it("returns false for env auth with empty variable", () => {
    const registry: ModelRegistry = {
      ...testRegistry,
      providers: [
        {
          ...testRegistry.providers[1]!,
          id: "openrouter",
          label: "OpenRouter",
          kind: "openai-compatible",
          baseUrl: "https://openrouter.ai/api/v1",
          location: "cloud",
          auth: { type: "env", envVar: "TEST_KEY" },
          extraHeaders: {},
          timeoutMs: 120000,
          enabled: true,
          createdAt: "2026-10-31T00:00:00Z",
          updatedAt: "2026-10-31T00:00:00Z",
        },
      ],
    };

    const provider = compileChain(registry, "default").find((p) => p.id === "openrouter/claude-3.5");
    assert.ok(provider, "Should find openrouter provider");
    const env = { TEST_KEY: "" };
    assert.strictEqual(hasUsableKey(provider, {}, env), false);
  });
});

describe("canHandleRequest", () => {
  it("allows requests when capabilities match", () => {
    const provider = compileChain(testRegistry, "default")[0]!;
    assert.ok(provider, "Should have provider");
    assert.strictEqual(
      canHandleRequest(provider, { needsTools: true }),
      true,
    );
  });

  it("blocks requests when tools explicitly unsupported", () => {
    const firstModel = testRegistry.models[0]!;
    const registry: ModelRegistry = {
      ...testRegistry,
      models: [
        {
          ...firstModel,
          capabilities: { ...firstModel.capabilities, tools: false },
        },
      ],
    };

    const provider = compileChain(registry, "default")[0]!;
    assert.ok(provider, "Should have provider");
    assert.strictEqual(
      canHandleRequest(provider, { needsTools: true }),
      false,
    );
  });

  it("allows unknown capabilities (doesn't gate)", () => {
    const firstModel = testRegistry.models[0]!;
    const registry: ModelRegistry = {
      ...testRegistry,
      models: [
        {
          ...firstModel,
          capabilities: { ...firstModel.capabilities, tools: "unknown" },
        },
      ],
    };

    const provider = compileChain(registry, "default")[0]!;
    assert.ok(provider, "Should have provider");
    assert.strictEqual(
      canHandleRequest(provider, { needsTools: true }),
      true,
    );
  });

  it("blocks requests exceeding context window", () => {
    const provider = compileChain(testRegistry, "default")[0]!;
    assert.ok(provider, "Should have provider");
    // 32768 * 1.25 = 40960, so 50000 tokens should be blocked
    assert.strictEqual(
      canHandleRequest(provider, { estimatedTokens: 50000 }),
      false,
    );
  });

  it("allows requests within context window", () => {
    const provider = compileChain(testRegistry, "default")[0]!;
    assert.ok(provider, "Should have provider");
    // 32768 / 1.25 = 26214, so 25000 tokens should be allowed
    assert.strictEqual(
      canHandleRequest(provider, { estimatedTokens: 25000 }),
      true,
    );
  });
});

describe("getProviderLabel", () => {
  it("returns formatted label", () => {
    const provider = compileChain(testRegistry, "default")[0]!;
    assert.ok(provider, "Should have provider");
    assert.strictEqual(getProviderLabel(provider), "Ollama — Qwen 2.5 14B");
  });
});
