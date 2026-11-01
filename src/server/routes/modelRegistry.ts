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
import { getRegistry, reloadRegistry } from "../../models/registry/init.js";
import { saveRegistry } from "../../models/registry/store.js";
import { redactSecretsFromObject } from "../../models/registry/redact.js";
import { log } from "../../log.js";
import type { ProviderRecord } from "../../models/registry/types.js";

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
        const body = JSON.parse(Buffer.concat(chunks).toString()) as any;

        // Validate required fields
        if (!body.kind || !body.baseUrl || !body.label) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "kind, baseUrl, and label are required" }));
          return;
        }

        // Generate ID
        const id = `provider_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        // Create provider record
        const now = new Date().toISOString();
        const provider: ProviderRecord = {
          id,
          kind: body.kind,
          baseUrl: body.baseUrl,
          label: body.label,
          location: body.baseUrl.startsWith("http://127.0.0.1") || body.baseUrl.startsWith("http://localhost") ? "local" : "cloud",
          enabled: body.enabled ?? true,
          auth: body.apiKey 
            ? { type: "header", credentialId: `cred_${Date.now()}`, header: "Authorization" }
            : { type: "none" },
          extraHeaders: body.extraHeaders ?? {},
          timeoutMs: 30000,
          createdAt: now,
          updatedAt: now,
        };

        // Add to registry
        registry.providers.push(provider);

        // Save registry
        saveRegistry(registry);

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

        // Import adapters
        const { OllamaAdapter } = await import("../../models/adapters/ollama.js");
        const { OpenAICompatAdapter } = await import("../../models/adapters/openaiCompat.js");
        const { AnthropicAdapter } = await import("../../models/adapters/anthropic.js");
        const { GeminiAdapter } = await import("../../models/adapters/gemini.js");

        // Create adapter options
        const adapterOpts = {
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          timeoutMs: 10000, // 10s for connection test
        };

        let adapter: any;
        switch (body.kind) {
          case "ollama":
            adapter = new OllamaAdapter(adapterOpts);
            break;
          case "openai-compatible":
          case "openai":
          case "openrouter":
          case "lmstudio":
          case "llamacpp":
          case "custom":
            adapter = new OpenAICompatAdapter(adapterOpts);
            break;
          case "anthropic":
            adapter = new AnthropicAdapter(adapterOpts);
            break;
          case "google-gemini":
          case "gemini":
            adapter = new GeminiAdapter(adapterOpts);
            break;
          default:
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: `Unknown provider kind: ${body.kind}` }));
            return;
        }

        // Test by listing models
        const models = await adapter.listModels();
        
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

        // Import adapters
        const { OllamaAdapter } = await import("../../models/adapters/ollama.js");
        const { OpenAICompatAdapter } = await import("../../models/adapters/openaiCompat.js");
        const { AnthropicAdapter } = await import("../../models/adapters/anthropic.js");
        const { GeminiAdapter } = await import("../../models/adapters/gemini.js");

        // Get API key from auth
        let apiKey: string | undefined;
        if (provider.auth.type === "header" && provider.auth.credentialId) {
          // TODO: Retrieve from vault using credentialId
          apiKey = undefined;
        } else if (provider.auth.type === "env") {
          apiKey = process.env[provider.auth.envVar];
        }

        // Create adapter
        const adapterOpts = {
          baseUrl: provider.baseUrl,
          apiKey,
          timeoutMs: 30000,
        };

        let adapter: any;
        if (provider.kind === "ollama") {
          adapter = new OllamaAdapter(adapterOpts);
        } else if (provider.kind === "openai-compatible") {
          adapter = new OpenAICompatAdapter(adapterOpts);
        } else if (provider.kind === "anthropic") {
          adapter = new AnthropicAdapter(adapterOpts);
        } else if (provider.kind === "google-gemini") {
          adapter = new GeminiAdapter(adapterOpts);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unsupported provider kind: ${provider.kind}` }));
          return;
        }

        // Discover models
        const discovered = await adapter.listModels();
        
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

        const added: any[] = [];
        for (const modelData of body.models) {
          const id = `model_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          const now = new Date().toISOString();
          
          const model = {
            id,
            remoteId: modelData.remoteId,
            providerId: provider.id,
            label: modelData.label || modelData.remoteId,
            enabled: true,
            capabilities: modelData.capabilities || {
              tools: false,
              vision: false,
              thinking: "none" as const,
              contextWindow: modelData.contextWindow || 8192,
            },
            defaults: {},
            tags: [],
            createdAt: now,
            updatedAt: now,
          };

          registry.models.push(model);
          added.push(model);
        }

        // Save registry
        saveRegistry(registry);

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
