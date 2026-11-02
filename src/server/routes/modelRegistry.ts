/**
 * HTTP routes for model registry management.
 * 
 * Routes:
 * - GET /api/model-registry          -> List all providers, models, chains
 * - GET /api/model-registry/providers -> List providers
 * - GET /api/model-registry/models    -> List models
 * - GET /api/model-registry/chains    -> List chains
 * - POST /api/model-registry/reload   -> Reload registry from disk
 */

import http from "node:http";
import { createAdapter } from "../../models/adapters/index.js";
import { getRegistry, reloadRegistry } from "../../models/registry/init.js";
import { resolveProviderApiKey } from "../../models/registry/registryClient.js";
import { saveRegistry } from "../../models/registry/store.js";
import { redactSecretsFromObject } from "../../models/registry/redact.js";
import { ProviderZ, ModelZ } from "../../models/registry/schema.js";
import { getVault } from "../../models/secrets/vault.js";
import { log } from "../../log.js";
import type { AuthScheme, ModelCapabilities, ModelRecord, ProviderKind, ProviderRecord } from "../../models/registry/types.js";

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** A label-derived slug that does not collide with providers already stored. */
export function uniqueProviderId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const root = SLUG.test(base) ? base : "provider";
  let id = root;
  let n = 2;
  while (used.has(id)) {
    const suffix = `-${n++}`;
    id = `${root.slice(0, 40 - suffix.length)}${suffix}`;
  }
  return id;
}

function authForKind(kind: ProviderKind, credentialId: string): AuthScheme {
  if (kind === "anthropic") return { type: "header", credentialId, header: "x-api-key" };
  if (kind === "google-gemini") return { type: "header", credentialId, header: "x-goog-api-key" };
  return { type: "bearer", credentialId };
}

export interface ProviderDraftInput {
  kind?: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  extraHeaders?: Record<string, string>;
}

/** Build a schema-valid provider. The raw key is handed to `putSecret` and never copied onto the record. */
export async function buildProviderDraft(
  takenIds: Iterable<string>,
  body: ProviderDraftInput,
  putSecret: (value: string, label: string) => Promise<{ credentialId: string }>,
): Promise<ProviderRecord> {
  const kind = adapterKind(body.kind ?? "");
  const label = (body.label ?? "").trim();
  const baseUrl = (body.baseUrl ?? "").trim();
  if (!kind || !label || !baseUrl) throw new Error("kind, baseUrl, and label are required");
  if (label.length > 60) throw new Error("Label too long (max 60 characters)");
  const now = new Date().toISOString();
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const auth: AuthScheme = key
    ? authForKind(kind, (await putSecret(key, label)).credentialId)
    : { type: "none" };
  return ProviderZ.parse({
    id: uniqueProviderId(label, takenIds),
    kind,
    baseUrl,
    label,
    location: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl) ? "local" : "cloud",
    enabled: body.enabled ?? true,
    auth,
    extraHeaders: body.extraHeaders ?? {},
    timeoutMs: 30_000,
    createdAt: now,
    updatedAt: now,
  });
}

export function buildModelDraft(
  provider: ProviderRecord,
  modelData: { remoteId?: string; label?: string; capabilities?: Partial<ModelCapabilities>; contextWindow?: number },
): ModelRecord {
  const remoteId = (modelData.remoteId ?? "").trim();
  if (!remoteId) throw new Error("remoteId is required");
  const given = modelData.capabilities ?? {};
  const contextWindow = typeof modelData.contextWindow === "number" && modelData.contextWindow > 0
    ? modelData.contextWindow
    : given.contextWindow ?? null;
  return ModelZ.parse({
    id: `${provider.id}/${remoteId}`,
    remoteId,
    providerId: provider.id,
    label: (modelData.label || remoteId).slice(0, 80),
    enabled: true,
    capabilities: {
      tools: given.tools ?? "unknown",
      vision: given.vision ?? "unknown",
      jsonMode: given.jsonMode ?? "unknown",
      thinking: given.thinking ?? "unknown",
      contextWindow,
      maxOutputTokens: given.maxOutputTokens ?? null,
      source: given.source ?? "provider-list",
    },
    defaults: {},
    tags: [],
  });
}

function adapterKind(kind: string): ProviderKind | null {
  if (kind === "ollama" || kind === "openai-compatible" || kind === "anthropic" || kind === "google-gemini") return kind;
  if (kind === "openai" || kind === "openrouter" || kind === "lmstudio" || kind === "llamacpp" || kind === "custom") return "openai-compatible";
  if (kind === "gemini") return "google-gemini";
  return null;
}

/**
 * Handle /api/model-registry/* routes.
 * 
 * @param req - HTTP request
 * @param res - HTTP response
 * @returns true if handled, false otherwise
 */
export function handleModelRegistryRoutes(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = req.url ?? "";

  // GET /api/model-registry - List everything
  if (url === "/api/model-registry" && req.method === "GET") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    // Redact secrets from response
    const safe = redactSecretsFromObject({
      providers: registry.providers,
      models: registry.models,
      chains: registry.chains,
      defaultModelId: registry.defaultModelId,
      fallbackModelId: registry.fallbackModelId,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(safe));
    return true;
  }

  // GET /api/model-registry/providers - List providers
  if (url === "/api/model-registry/providers" && req.method === "GET") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    const safe = redactSecretsFromObject(registry.providers);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ providers: safe }));
    return true;
  }

  // GET /api/model-registry/models - List models
  if (url === "/api/model-registry/models" && req.method === "GET") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: registry.models }));
    return true;
  }

  // GET /api/model-registry/chains - List chains
  if (url === "/api/model-registry/chains" && req.method === "GET") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chains: registry.chains }));
    return true;
  }

  // POST /api/model-registry/reload - Reload registry
  if (url === "/api/model-registry/reload" && req.method === "POST") {
    const registry = reloadRegistry();
    if (!registry) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to reload registry" }));
      return true;
    }

    log.info("[registry] Reloaded from disk");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers: registry.providers.length, models: registry.models.length }));
    return true;
  }

  // POST /api/model-registry/providers - Add provider
  if (url === "/api/model-registry/providers" && req.method === "POST") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    // Read body async
    (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderDraftInput;
        const provider = await buildProviderDraft(
          registry.providers.map((p) => p.id),
          body,
          (value, label) => getVault().put(value, label),
        );

        registry.providers.push(provider);
        try {
          saveRegistry(registry);
        } catch (error) {
          registry.providers.pop();
          throw error;
        }

        log.info(`[registry] Added provider: ${provider.label} (${provider.id})`);

        // Return created provider (redacted)
        const safe = redactSecretsFromObject(provider);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(safe));
      } catch (error) {
        log.error(`[registry] Failed to add provider: ${error}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    
    return true;
  }

  // POST /api/model-registry/test - Test provider connection
  if (url === "/api/model-registry/test" && req.method === "POST") {
    (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as any;

        // Validate
        if (!body.kind || !body.baseUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "kind and baseUrl are required" }));
          return;
        }

        log.info(`[registry] Testing connection to ${body.baseUrl} (${body.kind})`);

        const kind = adapterKind(String(body.kind));
        if (!kind) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: `Unknown provider kind: ${body.kind}` }));
          return;
        }

        let apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
        let authHeader = typeof body.authHeader === "string" ? body.authHeader : undefined;
        if (!apiKey && typeof body.providerId === "string") {
          const provider = getRegistry()?.providers.find((p) => p.id === body.providerId);
          if (provider) {
            apiKey = await resolveProviderApiKey(provider);
            if (provider.auth.type === "header") authHeader = provider.auth.header;
          }
        }

        const adapter = createAdapter(kind, {
          baseUrl: body.baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(authHeader ? { authHeader } : {}),
          timeoutMs: 10000,
        });

        const listModels = adapter.listModels;
        if (!listModels) throw new Error("هذا البروتوكول لا يسرد النماذج");
        const models = await listModels.call(adapter);
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Connected successfully. Found ${models.length} model(s).`,
          modelCount: models.length,
        }));
      } catch (error) {
        log.error(`[registry] Connection test failed: ${error}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: false, 
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    
    return true;
  }

  // GET /api/model-registry/providers/:id/discover - Discover models from provider
  if (url.startsWith("/api/model-registry/providers/") && url.includes("/discover") && req.method === "GET") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    (async () => {
      try {
        // Extract provider ID from URL
        const match = url.match(/\/api\/model-registry\/providers\/([^/]+)\/discover/);
        if (!match) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid URL format" }));
          return;
        }

        const providerId = match[1];
        const provider = registry.providers.find((p) => p.id === providerId);
        
        if (!provider) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provider not found" }));
          return;
        }

        log.info(`[registry] Discovering models from ${provider.label} (${provider.id})`);

        const apiKey = await resolveProviderApiKey(provider);
        const authHeader = provider.auth.type === "header" ? provider.auth.header : undefined;
        const adapter = createAdapter(provider.kind, {
          baseUrl: provider.baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(authHeader ? { authHeader } : {}),
          ...(Object.keys(provider.extraHeaders).length > 0 ? { extraHeaders: provider.extraHeaders } : {}),
          timeoutMs: provider.timeoutMs || 30000,
        });

        const listModels = adapter.listModels;
        if (!listModels) throw new Error("هذا البروتوكول لا يسرد النماذج");
        const discovered = await listModels.call(adapter);
        
        log.info(`[registry] Discovered ${discovered.length} models from ${provider.label}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: discovered }));
      } catch (error) {
        log.error(`[registry] Discovery failed: ${error}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    
    return true;
  }

  // DELETE /api/model-registry/providers/:id - Delete provider
  if (url.startsWith("/api/model-registry/providers/") && req.method === "DELETE" && !url.includes("/discover")) {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    try {
      // Extract provider ID
      const match = url.match(/\/api\/model-registry\/providers\/([^/]+)$/);
      if (!match) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid URL format" }));
        return true;
      }

      const providerId = match[1];
      const providerIndex = registry.providers.findIndex((p) => p.id === providerId);
      
      if (providerIndex === -1) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Provider not found" }));
        return true;
      }

      const provider = registry.providers[providerIndex];

      // TODO: Delete vault key if auth.type === "header" && credentialId exists
      // For now, just remove from registry

      // Remove provider
      registry.providers.splice(providerIndex, 1);

      // Remove associated models
      const removedModels = registry.models.filter((m) => m.providerId === providerId);
      registry.models = registry.models.filter((m) => m.providerId !== providerId);

      // Save registry
      saveRegistry(registry);

      log.info(`[registry] Deleted provider ${provider?.label ?? providerId} and ${removedModels.length} associated models`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, removedModels: removedModels.length }));
      return true;
    } catch (error) {
      log.error(`[registry] Failed to delete provider: ${error}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
  }

  // POST /api/model-registry/models - Add models (batch)
  if (url === "/api/model-registry/models" && req.method === "POST") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }

    (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as any;

        // Expect { providerId, models: [{ remoteId, capabilities?, ... }] }
        if (!body.providerId || !Array.isArray(body.models)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "providerId and models array required" }));
          return;
        }

        const provider = registry.providers.find((p) => p.id === body.providerId);
        if (!provider) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provider not found" }));
          return;
        }

        const added: ModelRecord[] = [];
        for (const modelData of body.models) {
          const model = buildModelDraft(provider, modelData);
          if (registry.models.some((m) => m.id === model.id)) continue;
          registry.models.push(model);
          added.push(model);
        }
        if (added.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no new models to add" }));
          return;
        }

        try {
          saveRegistry(registry);
        } catch (error) {
          for (const model of added) {
            const index = registry.models.indexOf(model);
            if (index >= 0) registry.models.splice(index, 1);
          }
          throw error;
        }

        log.info(`[registry] Added ${added.length} models from ${provider.label}`);

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ added: added.length, models: added }));
      } catch (error) {
        log.error(`[registry] Failed to add models: ${error}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    
    return true;
  }

  // Not a model registry route
  return false;
}
