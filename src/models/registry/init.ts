/**
 * Registry initialization and migration.
 * 
 * Called on server startup to:
 * 1. Check if migration is needed (no model-registry.json exists)
 * 2. Run migration if needed
 * 3. Load or create registry
 * 4. Make it available to the rest of the application
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import type { Config } from "../../config.js";
import { loadRegistry, saveRegistry, registryExists } from "./store.js";
import { migrateFromConfig } from "./migrate.js";
import { getVault, isVaultAvailable } from "../secrets/vault.js";
import { log } from "../../log.js";
import type { ModelRegistry } from "./types.js";

let cachedRegistry: ModelRegistry | null = null;

/**
 * Initialize the model registry.
 * 
 * - If registry exists: load it
 * - If not: migrate from config.json
 * - Cache the result for subsequent calls
 * 
 * @param config - Current config (for migration)
 * @returns Promise<ModelRegistry>
 */
export async function initializeRegistry(config: Config): Promise<ModelRegistry> {
  // Return cached if available
  if (cachedRegistry) return cachedRegistry;

  // Check if registry exists
  if (registryExists()) {
    try {
      const registry = loadRegistry();
      if (registry) {
        cachedRegistry = registry;
        log.info(`[registry] Loaded ${registry.providers.length} providers, ${registry.models.length} models`);
        return registry;
      }
    } catch (error) {
      log.error(`[registry] Failed to load registry: ${error}`);
      // Fall through to migration
    }
  }

  // No registry exists or load failed -> migrate
  log.info("[registry] No registry found, migrating from config.json...");

  try {
    // Create config backup
    const configPath = path.join(DATA_DIR, "..", "config.json");
    const backupPath = path.join(DATA_DIR, "..", "config.json.pre-registry.bak");
    if (fs.existsSync(configPath) && !fs.existsSync(backupPath)) {
      fs.copyFileSync(configPath, backupPath);
      log.info(`[registry] Created backup: ${backupPath}`);
    }

    // Run migration
    const vault = isVaultAvailable() ? getVault() : undefined;
    const mode = isVaultAvailable() ? "desktop" : "web";

    const registry = await migrateFromConfig({
      config,
      vault,
      mode,
    });

    // Save migrated registry
    saveRegistry(registry);
    cachedRegistry = registry;

    log.info(
      `[registry] Migration complete: ${registry.providers.length} providers, ${registry.models.length} models`
    );

    return registry;
  } catch (error) {
    log.error(`[registry] Migration failed: ${error}`);

    // Create minimal fallback registry
    const fallbackRegistry: ModelRegistry = {
      version: 1,
      providers: [],
      models: [],
      chains: [],
      defaultModelId: null,
      fallbackModelId: null,
    };

    cachedRegistry = fallbackRegistry;
    return fallbackRegistry;
  }
}

/**
 * Get the current registry (must be initialized first).
 * 
 * @returns ModelRegistry or null if not initialized
 */
export function getRegistry(): ModelRegistry | null {
  return cachedRegistry;
}

/**
 * Reload the registry from disk.
 * 
 * @returns ModelRegistry or null if load failed
 */
export function reloadRegistry(): ModelRegistry | null {
  try {
    const registry = loadRegistry();
    if (registry) {
      cachedRegistry = registry;
      return registry;
    }
  } catch (error) {
    log.error(`[registry] Failed to reload registry: ${error}`);
  }
  return null;
}

/**
 * Clear the cached registry (for testing).
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
}

/** Tests install a registry object without reading the user's data directory. */
export function setRegistryForTests(next: ModelRegistry | null): void {
  cachedRegistry = next;
}
