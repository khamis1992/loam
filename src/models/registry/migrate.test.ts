/**
 * Tests for config migration.
 * 
 * Validates the migration from legacy config.json to the unified registry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrateFromConfig, type VaultClient, type OllamaTagsFetcher } from "./migrate.js";
import type { Config } from "../../config.js";

// Fake vault for testing
class FakeVault implements VaultClient {
  private keys = new Map<string, { value: string; label: string }>();
  private idCounter = 0;

  async put(value: string, label: string): Promise<{ credentialId: string; hint: string }> {
    const id = `550e8400-e29b-41d4-a716-44665544${String(this.idCounter++).padStart(4, "0")}`;
    this.keys.set(id, { value, label });
    return { credentialId: id, hint: `...${value.slice(-4)}` };
  }

  getStored(id: string) {
    return this.keys.get(id);
  }
}

// Fake Ollama tags fetcher
const fakeOllamaTags: OllamaTagsFetcher = async (baseUrl: string) => {
  if (baseUrl === "http://127.0.0.1:11434") {
    return ["qwen2.5:14b", "ornith-1.5:9b", "llama3:8b"];
  }
  return [];
};

describe("migration", () => {
  it("migrates example config with defaults", async () => {
    const config = {
      model: "glm-5.3-flash:cloud",
      fallbackModel: "qwen2.5:14b",
      ollamaUrl: "http://127.0.0.1:11434",
      cloudModel: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key-12345",
      },
      failover: {
        providers: [
          { id: "ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "glm-5.3:cloud", apiKeyEnv: "", enabled: true },
          { id: "opencode-go", kind: "openai-compatible", baseUrl: "https://opencode.ai/inference/go/openai/v1", model: "opencode-go", apiKeyEnv: "OPENCODE_API_KEY", enabled: true },
          { id: "freellmapi", kind: "openai-compatible", baseUrl: "http://127.0.0.1:31415/v1", model: "freellmapi/auto", apiKeyEnv: "FREELLM_API_KEY", enabled: false },
          { id: "longcat", kind: "openai-compatible", baseUrl: "https://api.longcat.chat/openai/v1", model: "LongCat-2.5-Preview", apiKeyEnv: "LONGCAT_API_KEY", enabled: true },
          { id: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", apiKeyEnv: "OPENROUTER_API_KEY", enabled: true },
          { id: "ornith", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "ornith-1.5:9b", apiKeyEnv: "", enabled: true },
        ],
      },
      compression: {
        contextWindow: {
          "qwen2.5": 32768,
          "glm": 32768,
          "ornith": 8192,
        },
      },
    } as Config;

    const vault = new FakeVault();
    const registry = await migrateFromConfig({
      config: config as unknown as Config,
      vault,
      fetchOllamaTags: fakeOllamaTags,
      mode: "desktop",
    });

    // Check providers
    assert.ok(registry.providers.find((p) => p.id === "ollama-local"));
    assert.ok(registry.providers.find((p) => p.id === "cloud-legacy"));
    assert.ok(registry.providers.find((p) => p.id === "opencode-go"));
    assert.ok(registry.providers.find((p) => p.id === "freellmapi"));
    assert.ok(registry.providers.find((p) => p.id === "longcat"));
    assert.ok(registry.providers.find((p) => p.id === "openrouter"));

    // Check cloud-legacy has the migrated key
    const cloudLegacy = registry.providers.find((p) => p.id === "cloud-legacy")!;
    assert.strictEqual(cloudLegacy.auth.type, "bearer");
    if (cloudLegacy.auth.type === "bearer") {
      const stored = vault.getStored(cloudLegacy.auth.credentialId);
      assert.strictEqual(stored?.value, "test-key-12345");
    }

    // Check models
    assert.ok(registry.models.find((m) => m.id === "ollama-local/qwen2.5:14b"));
    assert.ok(registry.models.find((m) => m.id === "ollama-local/ornith-1.5:9b"));
    assert.ok(registry.models.find((m) => m.id === "cloud-legacy/glm-5.3-flash"));
    assert.ok(registry.models.find((m) => m.id === "opencode-go/opencode-go"));
    assert.ok(registry.models.find((m) => m.id === "freellmapi/freellmapi/auto"));
    assert.ok(registry.models.find((m) => m.id === "longcat/LongCat-2.5-Preview"));
    assert.ok(registry.models.find((m) => m.id === "openrouter/openrouter/free"));

    // Check freellmapi model is disabled (matching config)
    const freellmapiModel = registry.models.find((m) => m.id === "freellmapi/freellmapi/auto")!;
    assert.strictEqual(freellmapiModel.enabled, false);

    // Check context windows from compression config
    const qwenModel = registry.models.find((m) => m.id === "ollama-local/qwen2.5:14b")!;
    assert.strictEqual(qwenModel.capabilities.contextWindow, 32768);

    // Check default chain
    const defaultChain = registry.chains.find((c) => c.id === "default")!;
    assert.ok(defaultChain);
    assert.ok(defaultChain.modelIds.includes("ollama-local/qwen2.5:14b"));

    // Check default/fallback models
    assert.strictEqual(registry.defaultModelId, "cloud-legacy/glm-5.3-flash");
    assert.strictEqual(registry.fallbackModelId, "ollama-local/qwen2.5:14b");

    // Check migration metadata
    assert.ok(registry.migratedFrom);
    assert.ok(registry.migratedFrom.at);
    assert.ok(registry.migratedFrom.sourceHash);
  });

  it("keeps glm-5.3:cloud on Ollama when tags list it", async () => {
    const config: Partial<Config> = {
      model: "glm-5.3:cloud",
      fallbackModel: "qwen2.5:14b",
      ollamaUrl: "http://127.0.0.1:11434",
    } as Config;

    const fakeTagsWithGlm: OllamaTagsFetcher = async () => ["glm-5.3:cloud", "qwen2.5:14b"];

    const registry = await migrateFromConfig({
      config: config as Config,
      fetchOllamaTags: fakeTagsWithGlm,
      mode: "desktop",
    });

    // glm-5.3:cloud should be on ollama-local, not cloud-legacy
    const model = registry.models.find((m) => m.remoteId === "glm-5.3:cloud");
    assert.ok(model);
    assert.strictEqual(model.providerId, "ollama-local");
  });

  it("is idempotent (two runs produce identical JSON)", async () => {
    const config: Partial<Config> = {
      model: "qwen2.5:14b",
      fallbackModel: "llama3:8b",
      ollamaUrl: "http://127.0.0.1:11434",
    } as Config;

    const vault1 = new FakeVault();
    const vault2 = new FakeVault();

    const registry1 = await migrateFromConfig({
      config: config as Config,
      vault: vault1,
      fetchOllamaTags: fakeOllamaTags,
      mode: "desktop",
    });

    const registry2 = await migrateFromConfig({
      config: config as Config,
      vault: vault2,
      fetchOllamaTags: fakeOllamaTags,
      mode: "desktop",
    });

    // Normalize credential IDs (they're generated, so they differ)
    const normalize = (r: any) => {
      const copy = JSON.parse(JSON.stringify(r));
      for (const p of copy.providers) {
        if (p.auth.type === "bearer" || p.auth.type === "header") {
          p.auth.credentialId = "normalized-uuid";
        }
      }
      return copy;
    };

    assert.deepStrictEqual(normalize(registry1), normalize(registry2));
  });

  it("never includes key values in output or hash", async () => {
    const config: Partial<Config> = {
      model: "test:cloud",
      fallbackModel: "test2",
      ollamaUrl: "http://127.0.0.1:11434",
      cloudModel: {
        baseUrl: "https://example.com/v1",
        apiKey: "secret-key-do-not-leak",
      },
    } as Config;

    const vault = new FakeVault();
    const registry = await migrateFromConfig({
      config: config as Config,
      vault,
      mode: "desktop",
    });

    const json = JSON.stringify(registry);
    assert.ok(!json.includes("secret-key-do-not-leak"), "Key value leaked into registry JSON");
    assert.ok(!registry.migratedFrom!.sourceHash.includes("secret-key-do-not-leak"), "Key value leaked into hash");

    // Hash should contain "<set>" placeholder
    const config2 = { ...config, cloudModel: { ...config.cloudModel!, apiKey: "different-key" } };
    const registry2 = await migrateFromConfig({
      config: config2 as Config,
      vault: new FakeVault(),
      mode: "desktop",
    });

    // Same hash despite different key value
    assert.strictEqual(registry.migratedFrom!.sourceHash, registry2.migratedFrom!.sourceHash);
  });

  it("web mode uses env vars, doesn't modify config", async () => {
    const config: Partial<Config> = {
      model: "test:cloud",
      fallbackModel: "test2",
      ollamaUrl: "http://127.0.0.1:11434",
      cloudModel: {
        baseUrl: "https://example.com/v1",
        apiKey: "secret-key",
      },
    } as Config;

    const registry = await migrateFromConfig({
      config: config as Config,
      mode: "web",
    });

    const cloudProvider = registry.providers.find((p) => p.id === "cloud-legacy")!;
    assert.strictEqual(cloudProvider.auth.type, "env");
    if (cloudProvider.auth.type === "env") {
      assert.strictEqual(cloudProvider.auth.envVar, "LOAM_CLOUD_API_KEY");
    }

    // Config should be unchanged (no vault put was called)
    assert.strictEqual(config.cloudModel?.apiKey, "secret-key");
  });

  it("merge mode doesn't overwrite existing providers/models", async () => {
    const config: Partial<Config> = {
      model: "new-model",
      fallbackModel: "qwen2.5:14b",
      ollamaUrl: "http://127.0.0.1:11434",
    } as Config;

    const existingRegistry = {
      version: 1 as const,
      providers: [
        {
          id: "ollama-local",
          label: "My Custom Ollama",
          kind: "ollama" as const,
          baseUrl: "http://127.0.0.1:11434",
          location: "local" as const,
          auth: { type: "none" as const },
          extraHeaders: {},
          timeoutMs: 999999,
          enabled: true,
          createdAt: "2020-01-01T00:00:00Z",
          updatedAt: "2020-01-01T00:00:00Z",
        },
      ],
      models: [
        {
          id: "ollama-local/qwen2.5:14b",
          providerId: "ollama-local",
          remoteId: "qwen2.5:14b",
          label: "Custom Label",
          capabilities: {
            tools: true,
            vision: false,
            thinking: "toggle" as const,
            jsonMode: true,
            contextWindow: 64000,
            maxOutputTokens: 8192,
            source: "user" as const,
          },
          defaults: { temperature: 0.5 },
          enabled: true,
          tags: ["custom"],
        },
      ],
      chains: [{ id: "default", label: "Default", modelIds: ["ollama-local/qwen2.5:14b"] }],
      defaultModelId: "ollama-local/qwen2.5:14b",
      fallbackModelId: null,
    };

    const registry = await migrateFromConfig({
      config: config as Config,
      fetchOllamaTags: async () => ["new-model", "qwen2.5:14b"],
      mode: "desktop",
      mergeMode: true,
      existingRegistry,
    });

    // Existing provider/model should be unchanged
    const ollamaProvider = registry.providers.find((p) => p.id === "ollama-local")!;
    assert.strictEqual(ollamaProvider.label, "My Custom Ollama");
    assert.strictEqual(ollamaProvider.timeoutMs, 999999);

    const qwenModel = registry.models.find((m) => m.id === "ollama-local/qwen2.5:14b")!;
    assert.strictEqual(qwenModel.label, "Custom Label");
    assert.strictEqual(qwenModel.capabilities.contextWindow, 64000);
    assert.strictEqual(qwenModel.defaults.temperature, 0.5);
    assert.deepStrictEqual(qwenModel.tags, ["custom"]);

    // New model should be added
    const newModel = registry.models.find((m) => m.remoteId === "new-model");
    assert.ok(newModel);
  });
});
