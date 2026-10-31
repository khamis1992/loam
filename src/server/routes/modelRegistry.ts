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
import { redactSecretsFromObject } from "../../models/registry/redact.js";
import { log } from "../../log.js";

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

  // Not a model registry route
  return false;
}
