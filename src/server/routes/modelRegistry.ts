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

        // TODO: Instantiate adapter and test connection
        // For now, return mock success
        log.info(`[registry] Testing connection to ${body.baseUrl}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "Connection test pending full adapter integration" }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    
    return true;
  }

  // Not a model registry route
  return false;
}
