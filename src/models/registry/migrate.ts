/**
 * Migration from legacy config.json to the unified model registry.
 * 
 * Deterministic and idempotent. Running the migration twice on the same config
 * produces identical output (same JSON, same hash). Keys are NEVER written to
 * the registry JSON; they're moved to the vault.
 * 
 * Migration runs automatically on first load when model-registry.json doesn't exist.
 * Users can manually trigger "Re-import from config.json" to merge new entries.
 */

import { createHash } from "node:crypto";
import type { Config } from "../../config.js";
import type {
  ModelRegistry,
  ProviderRecord,
  ModelRecord,
  ModelChain,
  ModelCapabilities,
} from "./types.js";

/**
 * Vault interface (injected for testing).
 * In production, this is the real vault client from src/models/secrets/vault.ts.
 */
export interface VaultClient {
  put(value: string, label: string): Promise<{ credentialId: string; hint: string }>;
}

/**
 * Ollama tags fetcher (injected for testing).
 * In production, this calls the real Ollama /api/tags endpoint.
 */
export type OllamaTagsFetcher = (baseUrl: string) => Promise<string[]>;

/**
 * Migration options.
 */
export interface MigrateOptions {
  /** Configuration to migrate from */
  config: Config;
  /** Vault client for storing keys (desktop mode only; web mode uses env vars) */
  vault?: VaultClient;
  /** Function to fetch Ollama model list (for discovery) */
  fetchOllamaTags?: OllamaTagsFetcher;
  /** Mode: desktop or web (affects key storage) */
  mode?: "desktop" | "web";
  /** Merge mode: add missing providers/models without overwriting user edits */
  mergeMode?: boolean;
  /** Existing registry to merge into (merge mode only) */
  existingRegistry?: ModelRegistry;
}

/**
 * Hash the source config for idempotency tracking.
 * Keys are replaced with "<set>" or "<empty>" so the hash is stable even if
 * the actual key value changes.
 */
function hashSource(config: Config): string {
  const sanitized = {
    model: config.model,
    fallbackModel: config.fallbackModel,
    ollamaUrl: config.ollamaUrl,
    cloudModel: config.cloudModel
      ? {
          baseUrl: config.cloudModel.baseUrl,
          apiKey: config.cloudModel.apiKey ? "<set>" : "<empty>",
        }
      : undefined,
    failover: config.failover,
    coding: config.coding,
    compression: { contextWindow: config.compression?.contextWindow ?? {} },
  };

  const canonical = JSON.stringify(sanitized, Object.keys(sanitized).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Classify a hostname as local or cloud.
 * Matches Loam's existing LOCAL_HOSTS pattern.
 */
function classifyLocation(baseUrl: string): "local" | "cloud" {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "local";
    if (host.endsWith(".local") || host.endsWith(".localhost")) return "local";
    return "cloud";
  } catch {
    return "cloud"; // Invalid URL defaults to cloud
  }
}

/**
 * Extract context window from config.compression.contextWindow by longest prefix match.
 */
function lookupContextWindow(modelId: string, contextMap: Record<string, number>): number | null {
  let bestMatch = "";
  let bestValue: number | null = null;

  for (const [prefix, value] of Object.entries(contextMap)) {
    if (modelId.startsWith(prefix) && prefix.length > bestMatch.length) {
      bestMatch = prefix;
      bestValue = value;
    }
  }

  return bestValue;
}

/**
 * Create default capabilities for a model (all unknown).
 */
function defaultCapabilities(): ModelCapabilities {
  return {
    tools: "unknown",
    vision: "unknown",
    thinking: "unknown",
    jsonMode: "unknown",
    contextWindow: null,
    maxOutputTokens: null,
    source: "default",
  };
}

/**
 * Migrate legacy config to registry.
 * 
 * @param options - Migration options
 * @returns Promise<ModelRegistry>
 */
export async function migrateFromConfig(options: MigrateOptions): Promise<ModelRegistry> {
  const { config, vault, fetchOllamaTags, mode = "desktop", mergeMode = false, existingRegistry } = options;

  const providers: ProviderRecord[] = [];
  const models: ModelRecord[] = [];
  const chains: ModelChain[] = [];

  const providerIdMap = new Map<string, string>(); // (kind, baseUrl) -> id
  const now = new Date().toISOString();

  /**
   * Helper: get or create a provider.
   * Merges by (kind, baseUrl) so duplicate entries share the same provider.
   */
  async function getOrCreateProvider(
    id: string,
    label: string,
    kind: "ollama" | "openai-compatible",
    baseUrl: string,
    apiKey: string | undefined,
    apiKeyEnv: string,
  ): Promise<ProviderRecord> {
    const key = `${kind}:${baseUrl}`;
    const existing = providerIdMap.get(key);

    if (existing) {
      return providers.find((p) => p.id === existing)!;
    }

    // Check merge mode: don't overwrite existing provider
    if (mergeMode && existingRegistry) {
      const found = existingRegistry.providers.find((p) => p.kind === kind && p.baseUrl === baseUrl);
      if (found) {
        providers.push(found); // Add to new registry
        providerIdMap.set(key, found.id);
        return found;
      }
    }

    const location = classifyLocation(baseUrl);

    let auth: ProviderRecord["auth"];
    if (!apiKey && !apiKeyEnv) {
      auth = { type: "none" };
    } else if (mode === "web" || !vault) {
      // Web mode: always use env vars
      auth = { type: "env", envVar: apiKeyEnv || "LOAM_CLOUD_API_KEY" };
    } else if (apiKey && apiKey.trim()) {
      // Desktop mode: store in vault
      const { credentialId } = await vault.put(apiKey.trim(), `Migrated from config.json (${label})`);
      auth = { type: "bearer", credentialId };
    } else if (apiKeyEnv) {
      // No key value, but env var specified
      auth = { type: "env", envVar: apiKeyEnv };
    } else {
      auth = { type: "none" };
    }

    const provider: ProviderRecord = {
      id,
      label,
      kind,
      baseUrl,
      location,
      auth,
      extraHeaders: {},
      timeoutMs: location === "local" ? 600_000 : 120_000,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    providers.push(provider);
    providerIdMap.set(key, id);
    return provider;
  }

  /**
   * Helper: add a model to the registry.
   */
  function addModel(
    providerId: string,
    remoteId: string,
    label: string,
    capabilities: ModelCapabilities,
    enabled: boolean,
  ): ModelRecord {
    // Check merge mode: don't overwrite existing model
    const modelId = `${providerId}/${remoteId}`;
    if (mergeMode && existingRegistry) {
      const found = existingRegistry.models.find((m) => m.id === modelId);
      if (found) {
        models.push(found); // Add to new registry
        return found;
      }
    }

    const model: ModelRecord = {
      id: modelId,
      providerId,
      remoteId,
      label,
      capabilities,
      defaults: {},
      enabled,
      tags: [],
    };

    models.push(model);
    return model;
  }

  // 1. Create ollama-local provider from cfg.ollamaUrl
  const ollamaProvider = await getOrCreateProvider(
    "ollama-local",
    "Ollama",
    "ollama",
    config.ollamaUrl,
    undefined,
    "",
  );

  // Fetch Ollama tags if available
  const ollamaTags = new Set<string>();
  if (fetchOllamaTags) {
    try {
      const tags = await fetchOllamaTags(config.ollamaUrl);
      tags.forEach((t) => ollamaTags.add(t));
    } catch {
      // Ollama not reachable; proceed without tags
    }
  }

  // 2. Add cloud-legacy provider if cfg.cloudModel exists
  if (config.cloudModel?.baseUrl) {
    const cloudProvider = await getOrCreateProvider(
      "cloud-legacy",
      "Cloud (migrated)",
      "openai-compatible",
      config.cloudModel.baseUrl,
      config.cloudModel.apiKey,
      "LOAM_CLOUD_API_KEY",
    );

    // Models ending with :cloud (not in Ollama tags) go here
    for (const modelName of [config.model, config.fallbackModel]) {
      if (modelName.endsWith(":cloud") && !ollamaTags.has(modelName)) {
        const strippedName = modelName.replace(/:cloud$/, "");
        const caps = defaultCapabilities();
        const ctx = lookupContextWindow(strippedName, config.compression?.contextWindow ?? {});
        if (ctx) {
          caps.contextWindow = ctx;
          caps.source = "default";
        }
        addModel(cloudProvider.id, strippedName, strippedName, caps, true);
      }
    }
  }

  // 3. Process cfg.failover.providers
  if (config.failover?.providers) {
    for (const entry of config.failover.providers) {
      const provider = await getOrCreateProvider(
        entry.id,
        entry.id,
        entry.kind,
        entry.baseUrl,
        undefined, // Legacy failover doesn't have plaintext keys
        entry.apiKeyEnv,
      );

      // Each failover entry is one model
      const caps = defaultCapabilities();
      const ctx = lookupContextWindow(entry.model, config.compression?.contextWindow ?? {});
      if (ctx) {
        caps.contextWindow = ctx;
        caps.source = "default";
      }

      addModel(provider.id, entry.model, entry.model, caps, entry.enabled);

      // Update provider enabled state (enabled if any of its models is enabled)
      if (entry.enabled) {
        provider.enabled = true;
      }
    }
  }

  // 4. Add models from cfg.model and cfg.fallbackModel to ollama-local
  for (const modelName of [config.model, config.fallbackModel]) {
    if (!modelName) continue;

    // Skip if it's a :cloud model and we already added it to cloud-legacy
    if (modelName.endsWith(":cloud") && !ollamaTags.has(modelName)) continue;

    // Check if it's already added via failover
    const existingModel = models.find((m) => m.remoteId === modelName || m.remoteId === modelName.replace(/:cloud$/, ""));
    if (existingModel) continue;

    // Add to ollama-local
    const caps = defaultCapabilities();
    const ctx = lookupContextWindow(modelName, config.compression?.contextWindow ?? {});
    if (ctx) {
      caps.contextWindow = ctx;
      caps.source = "default";
    }

    addModel(ollamaProvider.id, modelName, modelName, caps, true);
  }

  // 5. Add discovered Ollama models (from /api/tags)
  for (const tag of ollamaTags) {
    if (models.find((m) => m.providerId === ollamaProvider.id && m.remoteId === tag)) continue;

    const caps = defaultCapabilities();
    const ctx = lookupContextWindow(tag, config.compression?.contextWindow ?? {});
    if (ctx) {
      caps.contextWindow = ctx;
      caps.source = "provider-list";
    }

    addModel(ollamaProvider.id, tag, tag, caps, false); // Discovered models default to disabled
  }

  // 6. Build chains
  // Default chain: all enabled models in failover order, then cfg.model, then cfg.fallbackModel
  const defaultChainIds: string[] = [];
  if (config.failover?.providers) {
    for (const entry of config.failover.providers) {
      if (!entry.enabled) continue;
      const modelId = `${entry.id}/${entry.model}`;
      if (models.find((m) => m.id === modelId)) {
        defaultChainIds.push(modelId);
      }
    }
  }

  // Add cfg.model and cfg.fallbackModel if not already in chain
  for (const modelName of [config.model, config.fallbackModel]) {
    if (!modelName) continue;
    const found = models.find((m) => {
      const matchDirect = m.remoteId === modelName;
      const matchStripped = modelName.endsWith(":cloud") && m.remoteId === modelName.replace(/:cloud$/, "");
      return matchDirect || matchStripped;
    });
    if (found && !defaultChainIds.includes(found.id)) {
      defaultChainIds.push(found.id);
    }
  }

  chains.push({
    id: "default",
    label: "Default",
    modelIds: defaultChainIds,
  });

  // Coding chain: from cfg.coding.chain, resolved via model names
  if (config.coding?.chain && config.coding.chain.length > 0) {
    const codingChainIds: string[] = [];
    for (const modelName of config.coding.chain) {
      const found = models.find((m) => {
        const matchDirect = m.remoteId === modelName;
        const matchId = m.id === modelName;
        const matchStripped = modelName.endsWith(":cloud") && m.remoteId === modelName.replace(/:cloud$/, "");
        return matchDirect || matchId || matchStripped;
      });
      if (found) {
        codingChainIds.push(found.id);
      }
    }

    if (codingChainIds.length > 0) {
      chains.push({
        id: "coding",
        label: "Coding",
        modelIds: codingChainIds,
      });
    }
  }

  // 7. Set default/fallback model IDs
  const defaultModel = models.find((m) => {
    const matchDirect = m.remoteId === config.model;
    const matchStripped = config.model.endsWith(":cloud") && m.remoteId === config.model.replace(/:cloud$/, "");
    return matchDirect || matchStripped;
  });

  const fallbackModel = models.find((m) => {
    const matchDirect = m.remoteId === config.fallbackModel;
    const matchStripped = config.fallbackModel.endsWith(":cloud") && m.remoteId === config.fallbackModel.replace(/:cloud$/, "");
    return matchDirect || matchStripped;
  });

  const registry: ModelRegistry = {
    version: 1,
    providers,
    models,
    chains,
    defaultModelId: defaultModel?.id ?? null,
    fallbackModelId: fallbackModel?.id ?? null,
    migratedFrom: {
      at: now,
      sourceHash: hashSource(config),
    },
  };

  return registry;
}
