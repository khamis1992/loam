/**
 * Tests for model reference resolution.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModelRef, isCloudModelRef, getDefaultModelId, getFallbackModelId } from "./resolve.js";
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
      id: "cloud-legacy",
      label: "Cloud",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      location: "cloud",
      auth: { type: "bearer", credentialId: "550e8400-e29b-41d4-a716-446655440000" },
      extraHeaders: {},
      timeoutMs: 120000,
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
      auth: { type: "env", envVar: "OPENROUTER_API_KEY" },
      extraHeaders: {},
      timeoutMs: 120000,
      enabled: true,
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
      id: "ollama/glm-5.3:cloud",
      providerId: "ollama",
      remoteId: "glm-5.3:cloud",
      label: "GLM 5.3 Cloud",
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
      id: "cloud-legacy/glm-5.3-flash",
      providerId: "cloud-legacy",
      remoteId: "glm-5.3-flash",
      label: "GLM 5.3 Flash",
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
  ],
  chains: [
    {
      id: "default",
      label: "Default",
      modelIds: ["ollama/qwen2.5:14b", "cloud-legacy/glm-5.3-flash"],
    },
  ],
  defaultModelId: "ollama/qwen2.5:14b",
  fallbackModelId: "cloud-legacy/glm-5.3-flash",
};

describe("resolveModelRef", () => {
  it("resolves exact registry ID (rule 1)", () => {
    const model = resolveModelRef("ollama/qwen2.5:14b", testRegistry);
    assert.ok(model);
    assert.strictEqual(model.id, "ollama/qwen2.5:14b");
  });

  it("returns undefined for disabled model", () => {
    const registry = {
      ...testRegistry,
      models: [
        ...testRegistry.models,
        {
          ...testRegistry.models[0],
          id: "ollama/disabled",
          remoteId: "disabled",
          enabled: false,
        },
      ],
    };

    const model = resolveModelRef("ollama/disabled", registry);
    assert.strictEqual(model, undefined);
  });

  it("resolves :cloud suffix to cloud-legacy first (rule 2a)", () => {
    const model = resolveModelRef("glm-5.3-flash:cloud", testRegistry);
    assert.ok(model);
    assert.strictEqual(model.id, "cloud-legacy/glm-5.3-flash");
  });

  it("resolves :cloud suffix to Ollama cloud model if not on cloud-legacy (rule 2b)", () => {
    const model = resolveModelRef("glm-5.3:cloud", testRegistry);
    assert.ok(model);
    assert.strictEqual(model.id, "ollama/glm-5.3:cloud");
  });

  it("returns undefined for unknown :cloud model (rule 2 fallback)", () => {
    const model = resolveModelRef("unknown-model:cloud", testRegistry);
    assert.strictEqual(model, undefined);
  });

  it("resolves bare name, Ollama first (rule 3)", () => {
    // Add same model name to both providers
    const firstModel = testRegistry.models[0]!;
    const registry: ModelRegistry = {
      ...testRegistry,
      models: [
        ...testRegistry.models,
        {
          id: "openrouter/qwen2.5:14b",
          providerId: "openrouter",
          remoteId: "qwen2.5:14b",
          label: "Qwen on OpenRouter",
          capabilities: firstModel.capabilities,
          defaults: {},
          enabled: true,
          tags: [],
        },
      ],
    };

    const model = resolveModelRef("qwen2.5:14b", registry);
    assert.ok(model);
    // Should pick Ollama first (local-first behavior)
    assert.strictEqual(model.id, "ollama/qwen2.5:14b");
  });

  it("returns undefined for unknown bare name (rule 4)", () => {
    const model = resolveModelRef("unknown-model", testRegistry);
    assert.strictEqual(model, undefined);
  });

  it("returns undefined for empty string", () => {
    const model = resolveModelRef("", testRegistry);
    assert.strictEqual(model, undefined);
  });

  it("returns undefined for undefined", () => {
    const model = resolveModelRef(undefined, testRegistry);
    assert.strictEqual(model, undefined);
  });
});

describe("isCloudModelRef", () => {
  it("returns true for cloud provider model", () => {
    assert.strictEqual(isCloudModelRef("cloud-legacy/glm-5.3-flash", testRegistry), true);
    assert.strictEqual(isCloudModelRef("openrouter/claude-3.5", testRegistry), true);
  });

  it("returns false for local provider model", () => {
    assert.strictEqual(isCloudModelRef("ollama/qwen2.5:14b", testRegistry), false);
  });

  it("returns false for undefined ref", () => {
    assert.strictEqual(isCloudModelRef(undefined, testRegistry), false);
  });

  it("returns false for unknown ref", () => {
    assert.strictEqual(isCloudModelRef("unknown/model", testRegistry), false);
  });
});

describe("getDefaultModelId", () => {
  it("returns registry default model", () => {
    assert.strictEqual(getDefaultModelId(testRegistry), "ollama/qwen2.5:14b");
  });

  it("falls back to first enabled model if default not set", () => {
    const registry: ModelRegistry = { ...testRegistry, defaultModelId: null };
    const defaultId = getDefaultModelId(registry);
    assert.ok(defaultId);
    assert.strictEqual(defaultId, "ollama/qwen2.5:14b");
  });

  it("returns undefined if no enabled models", () => {
    const registry: ModelRegistry = {
      ...testRegistry,
      defaultModelId: null,
      models: testRegistry.models.map((m) => ({ ...m, enabled: false })),
    };
    assert.strictEqual(getDefaultModelId(registry), undefined);
  });
});

describe("getFallbackModelId", () => {
  it("returns registry fallback model", () => {
    assert.strictEqual(getFallbackModelId(testRegistry), "cloud-legacy/glm-5.3-flash");
  });

  it("returns undefined if fallback not set", () => {
    const registry: ModelRegistry = { ...testRegistry, fallbackModelId: null };
    assert.strictEqual(getFallbackModelId(registry), undefined);
  });
});
