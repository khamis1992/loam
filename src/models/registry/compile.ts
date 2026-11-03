/**
 * Compile the registry to the failover layer format.
 * 
 * Turns the registry (providers + models + chains) into the FailoverProvider[]
 * array that the existing failover.ts expects. This keeps the router working
 * without changes during migration.
 * 
 * The compiled format adds registry references so the failover layer can:
 * - Access provider/model metadata (timeouts, capabilities, location)
 * - Check if a key is available (vault.hints)
 * - Apply capability gating (tools, vision, context window)
 */

import type { FailoverProvider } from "../../llm/failover.js";
import type { ModelRegistry, ProviderRecord, ModelRecord } from "./types.js";

/**
 * Extended failover provider with registry references.
 * 
 * The failover layer sees this as FailoverProvider (backward compatible).
 * Code that needs registry metadata casts to CompiledProvider.
 */
export interface CompiledProvider extends FailoverProvider {
  /** Full registry model ID (providerId/remoteId) */
  registryModelId: string;
  /** Provider metadata */
  providerRef: ProviderRecord;
  /** Model metadata */
  modelRef: ModelRecord;
}

/**
 * Compile a chain into FailoverProvider[] format.
 * 
 * @param registry - The model registry
 * @param chainId - Chain ID to compile ("default", "coding", etc.)
 * @returns Array of compiled providers (in chain order)
 */
export function compileChain(registry: ModelRegistry, chainId = "default"): CompiledProvider[] {
  // Find the requested chain (or fall back to default)
  const chain = registry.chains.find((c) => c.id === chainId);
  
  // If no chain found, use all enabled models (unordered)
  const modelIds = chain ? chain.modelIds : registry.models.filter((m) => m.enabled).map((m) => m.id);

  const compiled: CompiledProvider[] = [];

  for (const modelId of modelIds) {
    const model = registry.models.find((m) => m.id === modelId);
    if (!model || !model.enabled) continue; // Skip disabled or missing models

    const provider = registry.providers.find((p) => p.id === model.providerId);
    if (!provider || !provider.enabled) continue; // Skip disabled or missing providers

    // Map to FailoverProvider format
    const failoverProvider: CompiledProvider = {
      // FailoverProvider base fields
      id: model.id, // Use full registry ID (providerId/remoteId)
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: model.remoteId, // Send remoteId upstream (not the full registry ID)
      apiKeyEnv: provider.auth.type === "env" ? provider.auth.envVar : "",
      enabled: true,

      // CompiledProvider extensions
      registryModelId: model.id,
      providerRef: provider,
      modelRef: model,
    };

    compiled.push(failoverProvider);
  }

  return compiled;
}

/**
 * Check if a provider has a usable key.
 * 
 * Used by the failover layer to decide whether to try a provider.
 * 
 * @param provider - Compiled provider
 * @param vaultHints - Hints from the vault (credentialId -> "...XXXX")
 * @param env - Environment variables (for auth.type === "env")
 * @returns true if the provider has a key (or doesn't need one)
 */
export function hasUsableKey(
  provider: CompiledProvider,
  vaultHints: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const { auth } = provider.providerRef;

  switch (auth.type) {
    case "none":
      return true; // No key required

    case "bearer":
    case "header":
      // Check if the credential exists in vault
      return auth.credentialId in vaultHints;

    case "env":
      // Check if the environment variable is set and non-empty
      const value = env[auth.envVar];
      return typeof value === "string" && value.trim().length > 0;

    default:
      return false;
  }
}

/**
 * Get the provider's location (for cloud-only feature checks).
 * 
 * @param provider - Compiled provider
 * @returns "local" or "cloud"
 */
export function getProviderLocation(provider: CompiledProvider): "local" | "cloud" {
  return provider.providerRef.location;
}

/**
 * Check if a provider can handle a specific request.
 * 
 * Capability gating: skip providers that don't meet the requirements.
 * 
 * @param provider - Compiled provider
 * @param requirements - Request requirements
 * @returns true if the provider can handle the request
 */
export interface CapabilityRequirements {
  /** Request uses tools */
  needsTools?: boolean;
  /** Request has images */
  needsVision?: boolean;
  /** Estimated prompt tokens (for context window check) */
  estimatedTokens?: number;
}

export function canHandleRequest(
  provider: CompiledProvider,
  requirements: CapabilityRequirements,
): boolean {
  const { capabilities } = provider.modelRef;

  // Tools check: skip if model explicitly doesn't support tools
  if (requirements.needsTools && capabilities.tools === false) {
    return false;
  }

  // Vision check: skip if model explicitly doesn't support vision
  if (requirements.needsVision && capabilities.vision === false) {
    return false;
  }

  // Context window check: skip if estimated tokens * 1.25 > context window
  // The 1.25 safety factor matches FreeLLMAPI's approach
  if (requirements.estimatedTokens && capabilities.contextWindow) {
    const safetyFactor = 1.25;
    if (requirements.estimatedTokens * safetyFactor > capabilities.contextWindow) {
      return false;
    }
  }

  return true;
}

/**
 * Get a human-readable label for a compiled provider (for logs/UI).
 * 
 * @param provider - Compiled provider
 * @returns Label like "Ollama — qwen2.5:14b"
 */
export function getProviderLabel(provider: CompiledProvider): string {
  return `${provider.providerRef.label} — ${provider.modelRef.label}`;
}
