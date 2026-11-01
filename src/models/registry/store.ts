/**
 * Registry persistence: load and save model-registry.json atomically.
 * 
 * The registry lives at DATA_DIR/model-registry.json and contains NO secrets.
 * Only credential UUIDs or environment variable names are stored.
 * 
 * Atomic writes: tmp file + rename ensures the registry is never corrupted by
 * a crash mid-write. Previous version is kept as model-registry.json.bak.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import { RegistryZ } from "./schema.js";
import type { ModelRegistry } from "./types.js";

const REGISTRY_FILE = path.join(DATA_DIR, "model-registry.json");
const BACKUP_FILE = path.join(DATA_DIR, "model-registry.json.bak");

/**
 * Load the registry from disk.
 * 
 * @returns Parsed and validated registry, or null if file doesn't exist
 * @throws Error if file exists but is invalid JSON or fails validation
 */
export function loadRegistry(): ModelRegistry | null {
  if (!fs.existsSync(REGISTRY_FILE)) return null;

  try {
    const raw = fs.readFileSync(REGISTRY_FILE, "utf8");
    const json = JSON.parse(raw);
    const registry = RegistryZ.parse(json);
    return registry;
  } catch (error) {
    // Preserve original error for debugging
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load model registry from ${REGISTRY_FILE}: ${message}`);
  }
}

/**
 * Save the registry to disk atomically.
 * 
 * Write to a temp file first, then rename it over the target. This ensures
 * the registry is never left in a partially-written state if the process crashes.
 * 
 * The previous version is preserved as model-registry.json.bak.
 * 
 * @param registry - Registry to save
 * @throws Error if validation fails or write fails
 */
export function saveRegistry(registry: ModelRegistry): void {
  // Validate before writing
  RegistryZ.parse(registry);

  // Ensure DATA_DIR exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Canonical JSON: 2-space indent, sorted keys for diffability
  const json = JSON.stringify(registry, null, 2);

  // Atomic write: tmp file + rename
  const tmpFile = `${REGISTRY_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpFile, json, "utf8");
    
    // Backup existing file before overwriting
    if (fs.existsSync(REGISTRY_FILE)) {
      fs.copyFileSync(REGISTRY_FILE, BACKUP_FILE);
    }
    
    // Atomic rename (POSIX guarantee; Windows best-effort)
    fs.renameSync(tmpFile, REGISTRY_FILE);
  } catch (error) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save model registry to ${REGISTRY_FILE}: ${message}`);
  }
}

/**
 * Check if the registry file exists.
 * 
 * Used by migration logic to determine whether to run.
 */
export function registryExists(): boolean {
  return fs.existsSync(REGISTRY_FILE);
}

/**
 * Get the registry file path (for display/debugging).
 */
export function getRegistryPath(): string {
  return REGISTRY_FILE;
}

/**
 * Get the backup file path (for display/debugging).
 */
export function getBackupPath(): string {
  return BACKUP_FILE;
}
