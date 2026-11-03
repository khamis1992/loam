import type { ModelCapabilities, ModelRecord, ModelRegistry, ProviderRecord } from "./types.js";

function knownModels(registry: ModelRegistry): Set<string> {
  return new Set(registry.models.map((model) => model.id));
}

export function removeModelReferences(registry: ModelRegistry, modelId: string): void {
  for (const chain of registry.chains) {
    chain.modelIds = chain.modelIds.filter((id) => id !== modelId);
  }
  if (registry.defaultModelId === modelId) registry.defaultModelId = null;
  if (registry.fallbackModelId === modelId) registry.fallbackModelId = null;
}

/** Drop a provider, its models, and every chain entry that pointed at them. */
export function deleteProviderCascade(registry: ModelRegistry, providerId: string): string[] {
  const index = registry.providers.findIndex((provider) => provider.id === providerId);
  if (index < 0) throw new Error("Provider not found");
  const removed = registry.models.filter((model) => model.providerId === providerId).map((model) => model.id);
  registry.providers.splice(index, 1);
  registry.models = registry.models.filter((model) => model.providerId !== providerId);
  for (const modelId of removed) removeModelReferences(registry, modelId);
  return removed;
}

export function deleteModel(registry: ModelRegistry, modelId: string, replacementId?: string | null): void {
  const index = registry.models.findIndex((model) => model.id === modelId);
  if (index < 0) throw new Error("Model not found");
  if (registry.defaultModelId === modelId && !replacementId) {
    throw new Error("Choose a replacement for the default model");
  }
  if (replacementId && !registry.models.some((model) => model.id === replacementId && model.id !== modelId)) {
    throw new Error("Unknown replacement");
  }
  const wasDefault = registry.defaultModelId === modelId;
  const wasFallback = registry.fallbackModelId === modelId;
  registry.models.splice(index, 1);
  removeModelReferences(registry, modelId);
  if (wasDefault && replacementId) registry.defaultModelId = replacementId;
  if (wasFallback && replacementId) registry.fallbackModelId = replacementId;
}

export function reorderChain(registry: ModelRegistry, chainId: string, modelIds: string[]): void {
  const known = knownModels(registry);
  for (const modelId of modelIds) {
    if (!known.has(modelId)) throw new Error(`Unknown model: ${modelId}`);
  }
  let chain = registry.chains.find((item) => item.id === chainId);
  if (!chain) {
    if (chainId !== "default" && chainId !== "coding") throw new Error("Chain not found");
    chain = { id: chainId, label: chainId === "coding" ? "Coding" : "Default", modelIds: [] };
    registry.chains.push(chain);
  }
  chain.modelIds = [...modelIds];
}

export function setModelDefaults(
  registry: ModelRegistry,
  defaultModelId: string | null,
  fallbackModelId: string | null,
): void {
  const known = knownModels(registry);
  if (defaultModelId && !known.has(defaultModelId)) throw new Error("Unknown default model");
  if (fallbackModelId && !known.has(fallbackModelId)) throw new Error("Unknown fallback model");
  registry.defaultModelId = defaultModelId;
  registry.fallbackModelId = fallbackModelId;
}

export function applyModelPatch(
  model: ModelRecord,
  patch: {
    label?: string;
    enabled?: boolean;
    tags?: string[];
    capabilities?: Partial<ModelCapabilities>;
    defaults?: ModelRecord["defaults"];
    limits?: ModelRecord["limits"];
  },
): void {
  if (typeof patch.label === "string" && patch.label.trim()) model.label = patch.label.trim().slice(0, 80);
  if (typeof patch.enabled === "boolean") model.enabled = patch.enabled;
  if (Array.isArray(patch.tags)) model.tags = patch.tags.slice(0, 10);
  if (patch.capabilities) {
    model.capabilities = { ...model.capabilities, ...patch.capabilities, source: patch.capabilities.source ?? "user" };
  }
  if (patch.defaults) model.defaults = { ...model.defaults, ...patch.defaults };
  if (patch.limits) model.limits = { ...model.limits, ...patch.limits };
}

export function applyProviderPatch(
  provider: ProviderRecord,
  patch: { label?: string; baseUrl?: string; enabled?: boolean; timeoutMs?: number; extraHeaders?: Record<string, string> },
): void {
  if (typeof patch.label === "string" && patch.label.trim()) provider.label = patch.label.trim().slice(0, 60);
  if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) provider.baseUrl = patch.baseUrl.trim().replace(/\/+$/, "");
  if (typeof patch.enabled === "boolean") provider.enabled = patch.enabled;
  if (typeof patch.timeoutMs === "number") provider.timeoutMs = patch.timeoutMs;
  if (patch.extraHeaders) provider.extraHeaders = patch.extraHeaders;
  provider.updatedAt = new Date().toISOString();
}
