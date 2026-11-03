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

let registryFile = path.join(DATA_DIR, "model-registry.json");
let backupFile = path.join(DATA_DIR, "model-registry.json.bak");

/** Tests point the registry at a temp file so the user's data/model-registry.json stays untouched. */
export function setRegistryFileForTests(file: string | null): void {
  registryFile = file ?? path.join(DATA_DIR, "model-registry.json");
  backupFile = `${registryFile}.bak`;
}

/**
 * Load the registry from disk.
 * 
 * @returns Parsed and validated registry, or null if file doesn't exist
 * @throws Error if file exists but is invalid JSON or fails validation
 */
export function loadRegistry(): ModelRegistry | null {
  if (!fs.existsSync(registryFile)) return null;

  try {
    const raw = fs.readFileSync(registryFile, "utf8");
    const json = JSON.parse(raw);
    const registry = RegistryZ.parse(json);
    return registry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load model registry from ${registryFile}: ${message}`);
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
  const tmpFile = `${registryFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpFile, json, "utf8");
    
    // Backup existing file before overwriting
    if (fs.existsSync(registryFile)) {
      fs.copyFileSync(registryFile, backupFile);
    }
    
    // Atomic rename (POSIX guarantee; Windows best-effort)
    fs.renameSync(tmpFile, registryFile);
  } catch (error) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save model registry to ${registryFile}: ${message}`);
  }
}

/**
 * Check if the registry file exists.
 * 
 * Used by migration logic to determine whether to run.
 */
export function registryExists(): boolean {
  return fs.existsSync(registryFile);
}

/**
 * Get the registry file path (for display/debugging).
 */
export function getRegistryPath(): string {
  return registryFile;
}

/**
 * Get the backup file path (for display/debugging).
 */
export function getBackupPath(): string {
  return backupFile;
}
