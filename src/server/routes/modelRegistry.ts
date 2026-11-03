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
import { applyModelPatch, applyProviderPatch, deleteModel, deleteProviderCascade, reorderChain, setModelDefaults } from "../../models/registry/mutate.js";
import { redactSecretsFromObject } from "../../models/registry/redact.js";
import { ProviderZ, ModelZ } from "../../models/registry/schema.js";
import { getVault } from "../../models/secrets/vault.js";
import { migrateFromConfig } from "../../models/registry/migrate.js";
import { loadConfig } from "../../config.js";
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
  timeoutMs?: number;
  envVar?: string;
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
  const envVar = typeof body.envVar === "string" ? body.envVar.trim() : "";
  if (envVar && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(envVar)) throw new Error("Environment variable must be uppercase");
  const auth: AuthScheme = key
    ? authForKind(kind, (await putSecret(key, label)).credentialId)
    : envVar
      ? { type: "env", envVar }
      : { type: "none" };
  const timeoutMs = typeof body.timeoutMs === "number" && Number.isInteger(body.timeoutMs) && body.timeoutMs >= 5_000 && body.timeoutMs <= 1_800_000
    ? body.timeoutMs
    : 30_000;
  return ProviderZ.parse({
    id: uniqueProviderId(label, takenIds),
    kind,
    baseUrl,
    label,
    location: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl) ? "local" : "cloud",
    enabled: body.enabled ?? true,
    auth,
    extraHeaders: body.extraHeaders ?? {},
    timeoutMs,
    createdAt: now,
    updatedAt: now,
  });
}

export function buildModelDraft(
  provider: ProviderRecord,
  modelData: { remoteId?: string; label?: string; capabilities?: Partial<ModelCapabilities>; contextWindow?: number; defaults?: { temperature?: number } },
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
    defaults: typeof modelData.defaults?.temperature === "number" && modelData.defaults.temperature >= 0 && modelData.defaults.temperature <= 2
      ? { temperature: modelData.defaults.temperature }
      : {},
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
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function modelIdFrom(pathname: string): string {
  return decodeURIComponent(pathname.slice("/api/model-registry/models/".length));
}

function capabilityPatch(value: unknown): Partial<ModelCapabilities> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const patch: Partial<ModelCapabilities> = {};
  if (source.tools === true || source.tools === false || source.tools === "unknown") patch.tools = source.tools;
  if (source.vision === true || source.vision === false || source.vision === "unknown") patch.vision = source.vision;
  if (source.thinking === "none" || source.thinking === "toggle" || source.thinking === "always" || source.thinking === "unknown") patch.thinking = source.thinking;
  if (source.contextWindow === null) patch.contextWindow = null;
  else if (typeof source.contextWindow === "number" && Number.isInteger(source.contextWindow) && source.contextWindow > 0) patch.contextWindow = source.contextWindow;
  if (source.maxOutputTokens === null) patch.maxOutputTokens = null;
  else if (typeof source.maxOutputTokens === "number" && Number.isInteger(source.maxOutputTokens) && source.maxOutputTokens > 0) patch.maxOutputTokens = source.maxOutputTokens;
  if (source.source === "user" || source.source === "probe") patch.source = source.source;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function defaultsPatch(value: unknown): ModelRecord["defaults"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.temperature !== "number" || source.temperature < 0 || source.temperature > 2) return undefined;
  return { temperature: source.temperature };
}

function rememberTest(providerId: string | undefined, result: { ok: boolean; modelsFound?: number; error?: { code: "auth" | "unreachable" | "unknown"; message: string } }): void {
  if (!providerId) return;
  const registry = getRegistry();
  const provider = registry?.providers.find((item) => item.id === providerId);
  if (!registry || !provider) return;
  provider.lastTest = {
    at: new Date().toISOString(),
    ok: result.ok,
    ...(typeof result.modelsFound === "number" ? { modelsFound: result.modelsFound } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  provider.updatedAt = new Date().toISOString();
  saveRegistry(registry);
}

function limitPatch(value: unknown): ModelRecord["limits"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const limits: NonNullable<ModelRecord["limits"]> = {};
  for (const key of ["rpm", "rpd", "tpm", "tpd"] as const) {
    const number = source[key];
    if (typeof number === "number" && Number.isInteger(number) && number > 0) limits[key] = number;
  }
  return limits;
}

async function probeTools(provider: ProviderRecord, remoteId: string): Promise<boolean> {
  const apiKey = await resolveProviderApiKey(provider);
  const authHeader = provider.auth.type === "header" ? provider.auth.header : undefined;
  const adapter = createAdapter(provider.kind, {
    baseUrl: provider.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(authHeader ? { authHeader } : {}),
    ...(Object.keys(provider.extraHeaders).length > 0 ? { extraHeaders: provider.extraHeaders } : {}),
    timeoutMs: Math.min(provider.timeoutMs || 30_000, 20_000),
  });
  const result = await adapter.chat({
    model: remoteId,
    messages: [{ role: "user", content: "Call the ping tool." }],
    tools: [{ type: "function", function: { name: "ping", description: "ping", parameters: { type: "object", properties: {} } } }],
  });
  return result.toolCalls.length > 0;
}

export function handleModelRegistryRoutes(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = (req.url ?? "").split("?")[0] ?? "";

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
    let testedProviderId: string | undefined;
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

        testedProviderId = typeof body.providerId === "string" ? body.providerId : undefined;
        let apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
        let authHeader = typeof body.authHeader === "string" ? body.authHeader : undefined;
        if (!apiKey && testedProviderId) {
          const provider = getRegistry()?.providers.find((p) => p.id === testedProviderId);
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
        
        rememberTest(testedProviderId, { ok: true, modelsFound: models.length });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: true, 
          code: "connected",
          message: "متصل",
          modelCount: models.length,
        }));
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        const code = /401|403|unauthorized|invalid api key|authentication/i.test(message)
          ? "auth"
          : /ECONNREFUSED|ENOTFOUND|fetch failed|timeout|aborted|unreachable/i.test(message)
            ? "unreachable"
            : "unknown";
        rememberTest(testedProviderId, { ok: false, error: { code, message } });
        log.error(`[registry] Connection test failed: ${code}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: false,
          code,
          error: code === "auth" ? "المفتاح مرفوض" : code === "unreachable" ? "غير متاح" : message,
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
      if (!providerId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid URL format" }));
        return true;
      }
      const providerIndex = registry.providers.findIndex((p) => p.id === providerId);
      
      if (providerIndex === -1) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Provider not found" }));
        return true;
      }

      const removedModels = deleteProviderCascade(registry, providerId);
      saveRegistry(registry);

      log.info(`[registry] Deleted provider ${providerId} and ${removedModels.length} associated models`);

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

  if (url.startsWith("/api/model-registry/providers/") && req.method === "PUT" && !url.includes("/discover")) {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }
    const providerId = url.slice("/api/model-registry/providers/".length);
    const provider = registry.providers.find((item) => item.id === providerId);
    if (!provider) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Provider not found" }));
      return true;
    }
    void readBody(req).then(async (body) => {
      if (typeof body.label === "string" || typeof body.baseUrl === "string" || typeof body.enabled === "boolean" || typeof body.timeoutMs === "number") {
        applyProviderPatch(provider, {
          label: typeof body.label === "string" ? body.label : undefined,
          baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
          extraHeaders: body.extraHeaders && typeof body.extraHeaders === "object" && !Array.isArray(body.extraHeaders)
            ? body.extraHeaders as Record<string, string>
            : undefined,
        });
      }
      if (body.removeKey === true) provider.auth = { type: "none" };
      if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        const stored = await getVault().put(body.apiKey.trim(), provider.label);
        provider.auth = authForKind(provider.kind, stored.credentialId);
      }
      saveRegistry(registry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(redactSecretsFromObject(provider)));
    }).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
    return true;
  }

  if (req.method === "POST" && url.startsWith("/api/model-registry/providers/") && url.endsWith("/probe")) {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }
    const providerId = url.slice("/api/model-registry/providers/".length, -"/probe".length);
    const provider = registry.providers.find((item) => item.id === providerId);
    if (!provider) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Provider not found" }));
      return true;
    }
    void readBody(req).then(async (body) => {
      const remoteId = typeof body.remoteId === "string" ? body.remoteId.trim() : "";
      if (!remoteId) throw new Error("remoteId is required");
      const tools = await probeTools(provider, remoteId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools }));
    }).catch((error) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools: "unknown", error: error instanceof Error ? error.message : String(error) }));
    });
    return true;
  }

  if (req.method === "POST" && url.startsWith("/api/model-registry/models/") && url.endsWith("/probe")) {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }
    const modelId = decodeURIComponent(url.slice("/api/model-registry/models/".length, -"/probe".length));
    const model = registry.models.find((item) => item.id === modelId);
    const provider = model ? registry.providers.find((item) => item.id === model.providerId) : undefined;
    if (!model || !provider) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Model not found" }));
      return true;
    }
    void (async () => {
      const tools = await probeTools(provider, model.remoteId);
      applyModelPatch(model, { capabilities: { tools, source: "probe" } });
      saveRegistry(registry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools }));
    })().catch((error) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools: "unknown", error: error instanceof Error ? error.message : String(error) }));
    });
    return true;
  }

  if (url.startsWith("/api/model-registry/models/") && (req.method === "PUT" || req.method === "DELETE")) {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }
    const modelId = modelIdFrom(url);
    const model = registry.models.find((item) => item.id === modelId);
    if (!model) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Model not found" }));
      return true;
    }
    if (req.method === "DELETE") {
      void readBody(req).then((body) => {
        const replacement = typeof body.replacementId === "string" ? body.replacementId : null;
        deleteModel(registry, modelId, replacement);
        saveRegistry(registry);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }).catch((error) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
      return true;
    }
    void readBody(req).then((body) => {
      applyModelPatch(model, {
        label: typeof body.label === "string" ? body.label : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
        capabilities: capabilityPatch(body.capabilities),
        defaults: defaultsPatch(body.defaults),
        limits: limitPatch(body.limits),
      });
      saveRegistry(registry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(model));
    }).catch((error) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
    return true;
  }

  if (url.startsWith("/api/model-registry/chains/") && req.method === "PUT") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }
    const chainId = decodeURIComponent(url.slice("/api/model-registry/chains/".length));
    void readBody(req).then((body) => {
      const modelIds = Array.isArray(body.modelIds) ? body.modelIds.filter((id): id is string => typeof id === "string") : [];
      reorderChain(registry, chainId, modelIds);
      saveRegistry(registry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, modelIds }));
    }).catch((error) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
    return true;
  }

  if (url === "/api/model-registry/defaults" && req.method === "PUT") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }
    void readBody(req).then((body) => {
      setModelDefaults(
        registry,
        typeof body.defaultModelId === "string" ? body.defaultModelId : null,
        typeof body.fallbackModelId === "string" ? body.fallbackModelId : null,
      );
      saveRegistry(registry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }).catch((error) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
    return true;
  }

  if (url === "/api/model-registry/reimport" && req.method === "POST") {
    const registry = getRegistry();
    if (!registry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registry not initialized" }));
      return true;
    }
    void (async () => {
      const imported = await migrateFromConfig({
        config: loadConfig(),
        vault: getVault(),
        fetchOllamaTags: async () => [],
        mode: "desktop",
        mergeMode: true,
        existingRegistry: registry,
      });
      for (const provider of registry.providers) {
        if (!imported.providers.some((item) => item.id === provider.id)) imported.providers.push(provider);
      }
      for (const model of registry.models) {
        if (!imported.models.some((item) => item.id === model.id)) imported.models.push(model);
      }
      registry.providers = imported.providers;
      registry.models = imported.models;
      registry.chains = imported.chains.length > 0 ? imported.chains : registry.chains;
      registry.defaultModelId = imported.defaultModelId ?? registry.defaultModelId;
      registry.fallbackModelId = imported.fallbackModelId ?? registry.fallbackModelId;
      registry.migratedFrom = imported.migratedFrom;
      saveRegistry(registry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, providers: registry.providers.length, models: registry.models.length }));
    })().catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
    return true;
  }

  // Not a model registry route
  return false;
}
