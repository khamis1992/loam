/**
 * Tests for zod registry schemas.
 * 
 * Validates that the schemas correctly accept valid data and reject invalid data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RegistryZ, ProviderZ, ModelZ, AuthSchemeZ } from "./schema.js";
import type { ModelRegistry } from "./types.js";

describe("schema validation", () => {
  it("accepts valid complete registry", () => {
    const registry: ModelRegistry = {
      version: 1,
      providers: [
        {
          id: "ollama-local",
          label: "Ollama",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          location: "local",
          auth: { type: "none" },
          extraHeaders: {},
          timeoutMs: 120000,
          enabled: true,
          createdAt: "2026-10-31T00:00:00Z",
          updatedAt: "2026-10-31T00:00:00Z",
        },
      ],
      models: [
        {
          id: "ollama-local/qwen2.5:14b",
          providerId: "ollama-local",
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
      ],
      chains: [
        {
          id: "default",
          label: "Default",
          modelIds: ["ollama-local/qwen2.5:14b"],
        },
      ],
      defaultModelId: "ollama-local/qwen2.5:14b",
      fallbackModelId: null,
    };

    const result = RegistryZ.safeParse(registry);
    assert.ok(result.success, `Registry should be valid: ${JSON.stringify(result.error?.issues)}`);
  });

  it("strips trailing slashes from URLs", () => {
    const provider = {
      id: "test",
      label: "Test",
      kind: "ollama",
      baseUrl: "http://localhost:11434/",
      location: "local",
      auth: { type: "none" },
      extraHeaders: {},
      timeoutMs: 120000,
      enabled: true,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    } as const;

    const result = ProviderZ.safeParse(provider);
    assert.ok(result.success);
    assert.strictEqual(result.data.baseUrl, "http://localhost:11434");
  });

  it("rejects duplicate provider IDs", () => {
    const registry = {
      version: 1,
      providers: [
        {
          id: "test",
          label: "Test 1",
          kind: "ollama",
          baseUrl: "http://localhost:11434",
          location: "local",
          auth: { type: "none" },
          extraHeaders: {},
          timeoutMs: 120000,
          enabled: true,
          createdAt: "2026-10-31T00:00:00Z",
          updatedAt: "2026-10-31T00:00:00Z",
        },
        {
          id: "test",
          label: "Test 2",
          kind: "ollama",
          baseUrl: "http://localhost:11435",
          location: "local",
          auth: { type: "none" },
          extraHeaders: {},
          timeoutMs: 120000,
          enabled: true,
          createdAt: "2026-10-31T00:00:00Z",
          updatedAt: "2026-10-31T00:00:00Z",
        },
      ],
      models: [],
      chains: [],
      defaultModelId: null,
      fallbackModelId: null,
    };

    const result = RegistryZ.safeParse(registry);
    assert.ok(!result.success);
    assert.match(result.error.message, /duplicate provider/i);
  });

  it("rejects duplicate model IDs", () => {
    const registry = {
      version: 1,
      providers: [
        {
          id: "test",
          label: "Test",
          kind: "ollama",
          baseUrl: "http://localhost:11434",
          location: "local",
          auth: { type: "none" },
          extraHeaders: {},
          timeoutMs: 120000,
          enabled: true,
          createdAt: "2026-10-31T00:00:00Z",
          updatedAt: "2026-10-31T00:00:00Z",
        },
      ],
      models: [
        {
          id: "test/model",
          providerId: "test",
          remoteId: "model",
          label: "Model 1",
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
        {
          id: "test/model",
          providerId: "test",
          remoteId: "model",
          label: "Model 2",
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
      chains: [],
      defaultModelId: null,
      fallbackModelId: null,
    };

    const result = RegistryZ.safeParse(registry);
    assert.ok(!result.success);
    assert.match(result.error.message, /duplicate model/i);
  });

  it("rejects model with unknown provider", () => {
    const registry = {
      version: 1,
      providers: [],
      models: [
        {
          id: "unknown/model",
          providerId: "unknown",
          remoteId: "model",
          label: "Model",
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
      chains: [],
      defaultModelId: null,
      fallbackModelId: null,
    };

    const result = RegistryZ.safeParse(registry);
    assert.ok(!result.success);
    assert.match(result.error.message, /unknown provider/i);
  });

  it("rejects chain referencing unknown model", () => {
    const registry = {
      version: 1,
      providers: [],
      models: [],
      chains: [
        {
          id: "test",
          label: "Test",
          modelIds: ["unknown/model"],
        },
      ],
      defaultModelId: null,
      fallbackModelId: null,
    };

    const result = RegistryZ.safeParse(registry);
    assert.ok(!result.success);
    assert.match(result.error.message, /unknown model/i);
  });

  it("rejects default referencing unknown model", () => {
    const registry = {
      version: 1,
      providers: [],
      models: [],
      chains: [],
      defaultModelId: "unknown/model",
      fallbackModelId: null,
    };

    const result = RegistryZ.safeParse(registry);
    assert.ok(!result.success);
    assert.match(result.error.message, /unknown model/i);
  });

  it("rejects Authorization in extraHeaders", () => {
    const provider = {
      id: "test",
      label: "Test",
      kind: "openai-compatible",
      baseUrl: "http://localhost:8080",
      location: "local",
      auth: { type: "none" },
      extraHeaders: { Authorization: "Bearer secret" },
      timeoutMs: 120000,
      enabled: true,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    } as const;

    const result = ProviderZ.safeParse(provider);
    assert.ok(!result.success);
    assert.match(result.error.message, /secret headers/i);
  });

  it("rejects x-api-key in extraHeaders", () => {
    const provider = {
      id: "test",
      label: "Test",
      kind: "openai-compatible",
      baseUrl: "http://localhost:8080",
      location: "local",
      auth: { type: "none" },
      extraHeaders: { "x-api-key": "secret" },
      timeoutMs: 120000,
      enabled: true,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    } as const;

    const result = ProviderZ.safeParse(provider);
    assert.ok(!result.success);
    assert.match(result.error.message, /secret headers/i);
  });

  it("rejects ftp:// URLs", () => {
    const provider = {
      id: "test",
      label: "Test",
      kind: "ollama",
      baseUrl: "ftp://localhost:11434",
      location: "local",
      auth: { type: "none" },
      extraHeaders: {},
      timeoutMs: 120000,
      enabled: true,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    } as const;

    const result = ProviderZ.safeParse(provider);
    assert.ok(!result.success);
    assert.match(result.error.message, /http.*https/i);
  });

  it("rejects non-ASCII in header value", () => {
    const provider = {
      id: "test",
      label: "Test",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      location: "local",
      auth: { type: "none" },
      extraHeaders: { "x-custom": "Hello 世界" },
      timeoutMs: 120000,
      enabled: true,
      createdAt: "2026-10-31T00:00:00Z",
      updatedAt: "2026-10-31T00:00:00Z",
    } as const;

    const result = ProviderZ.safeParse(provider);
    assert.ok(!result.success);
    assert.match(result.error.message, /printable ascii/i);
  });

  it("rejects malformed model ID (not providerId/remoteId)", () => {
    const registry = {
      version: 1,
      providers: [
        {
          id: "test",
          label: "Test",
          kind: "ollama",
          baseUrl: "http://localhost:11434",
          location: "local",
          auth: { type: "none" },
          extraHeaders: {},
          timeoutMs: 120000,
          enabled: true,
          createdAt: "2026-10-31T00:00:00Z",
          updatedAt: "2026-10-31T00:00:00Z",
        },
      ],
      models: [
        {
          id: "wrong-format",
          providerId: "test",
          remoteId: "model",
          label: "Model",
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
      chains: [],
      defaultModelId: null,
      fallbackModelId: null,
    };

    const result = RegistryZ.safeParse(registry);
    assert.ok(!result.success);
    assert.match(result.error.message, /providerId.*remoteId/i);
  });

  it("accepts valid auth schemes", () => {
    const none = { type: "none" } as const;
    const bearer = { type: "bearer", credentialId: "550e8400-e29b-41d4-a716-446655440000" } as const;
    const header = { type: "header", credentialId: "550e8400-e29b-41d4-a716-446655440000", header: "x-api-key" } as const;
    const env = { type: "env", envVar: "MY_API_KEY" } as const;

    assert.ok(AuthSchemeZ.safeParse(none).success);
    assert.ok(AuthSchemeZ.safeParse(bearer).success);
    assert.ok(AuthSchemeZ.safeParse(header).success);
    assert.ok(AuthSchemeZ.safeParse(env).success);
  });

  it("rejects invalid UUID in bearer auth", () => {
    const auth = { type: "bearer", credentialId: "not-a-uuid" } as const;
    const result = AuthSchemeZ.safeParse(auth);
    assert.ok(!result.success);
    assert.match(result.error.message, /uuid/i);
  });

  it("rejects invalid env var name", () => {
    const auth = { type: "env", envVar: "123-invalid" } as const;
    const result = AuthSchemeZ.safeParse(auth);
    assert.ok(!result.success);
    assert.match(result.error.message, /uppercase.*underscores/i);
  });
});
