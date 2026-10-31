/**
 * Model reference resolution.
 * 
 * Resolves model names from various sources (UI, config, routing map, coding chain)
 * to registry model records. Supports legacy `:cloud` suffix and bare names for
 * backward compatibility.
 * 
 * Resolution rules (tried in order):
 * 1. Exact registry ID (providerId/remoteId)
 * 2. Legacy `:cloud` suffix -> cloud-legacy provider or Ollama cloud model
 * 3. Bare name -> first enabled model with matching remoteId (Ollama first)
 * 4. undefined -> caller uses legacy path (keeps old code working)
 */

import type { ModelRegistry, ModelRecord } from "./types.js";

/**
 * Resolve a model reference to a registry model record.
 * 
 * @param ref - Model reference (name, ID, or legacy format)
 * @param registry - The model registry
 * @returns Model record if found, undefined otherwise
 */
export function resolveModelRef(ref: string | undefined, registry: ModelRegistry): ModelRecord | undefined {
  if (!ref) return undefined;

  // Rule 1: Exact registry ID (providerId/remoteId)
  if (ref.includes("/")) {
    return registry.models.find((m) => m.id === ref && m.enabled);
  }

  // Rule 2: Legacy `:cloud` suffix
  if (ref.endsWith(":cloud")) {
    const strippedName = ref.slice(0, -6); // Remove ":cloud"

    // First, check cloud-legacy provider (migrated cloudModel)
    const cloudLegacyModel = registry.models.find(
      (m) => m.providerId === "cloud-legacy" && m.remoteId === strippedName && m.enabled,
    );
    if (cloudLegacyModel) return cloudLegacyModel;

    // Second, check Ollama providers for the full name (Ollama cloud models like glm-5.3:cloud)
    const ollamaCloudModel = registry.models.find(
      (m) => {
        const provider = registry.providers.find((p) => p.id === m.providerId);
        return provider?.kind === "ollama" && m.remoteId === ref && m.enabled;
      },
    );
    if (ollamaCloudModel) return ollamaCloudModel;

    // Not found, undefined -> legacy path
    return undefined;
  }

  // Rule 3: Bare name -> first enabled model with matching remoteId
  // Prioritize Ollama providers (local-first behavior)
  const ollamaProviders = registry.providers.filter((p) => p.kind === "ollama");
  const otherProviders = registry.providers.filter((p) => p.kind !== "ollama");

  for (const provider of [...ollamaProviders, ...otherProviders]) {
    const model = registry.models.find(
      (m) => m.providerId === provider.id && m.remoteId === ref && m.enabled,
    );
    if (model) return model;
  }

  // Rule 4: Not found -> undefined (caller uses legacy path)
  return undefined;
}

/**
 * Resolve multiple model references.
 * 
 * @param refs - Array of model references
 * @param registry - The model registry
 * @returns Array of resolved models (skipping undefined)
 */
export function resolveModelRefs(refs: string[], registry: ModelRegistry): ModelRecord[] {
  const resolved: ModelRecord[] = [];
  
  for (const ref of refs) {
    const model = resolveModelRef(ref, registry);
    if (model) {
      resolved.push(model);
    }
  }

  return resolved;
}

/**
 * Check if a model reference resolves to a cloud provider.
 * 
 * Used by features that require cloud models (build, planning, etc.).
 * 
 * @param ref - Model reference
 * @param registry - The model registry
 * @returns true if the model is on a cloud provider
 */
export function isCloudModelRef(ref: string | undefined, registry: ModelRegistry): boolean {
  if (!ref) return false;

  const model = resolveModelRef(ref, registry);
  if (!model) return false; // Not in registry -> can't determine

  const provider = registry.providers.find((p) => p.id === model.providerId);
  return provider?.location === "cloud";
}

/**
 * Get the default model ID (for new tasks).
 * 
 * Falls back to the first enabled model if defaultModelId is not set.
 * 
 * @param registry - The model registry
 * @returns Model ID or undefined
 */
export function getDefaultModelId(registry: ModelRegistry): string | undefined {
  if (registry.defaultModelId) {
    const model = registry.models.find((m) => m.id === registry.defaultModelId);
    if (model?.enabled) return model.id;
  }

  // Fallback: first enabled model
  const firstEnabled = registry.models.find((m) => m.enabled);
  return firstEnabled?.id;
}

/**
 * Get the fallback model ID (for when the default fails).
 * 
 * @param registry - The model registry
 * @returns Model ID or undefined
 */
export function getFallbackModelId(registry: ModelRegistry): string | undefined {
  if (registry.fallbackModelId) {
    const model = registry.models.find((m) => m.id === registry.fallbackModelId);
    if (model?.enabled) return model.id;
  }

  return undefined;
}
