/**
 * Registry run client — the routing leg PR #4 left open.
 *
 * Picking a NATIVE-protocol registry model (Anthropic, Google Gemini) from
 * the model picker writes a `registry:<providerId>/<modelId>` ref into
 * settings.model and the registry's defaultModelId. This module turns that
 * ref into a chat client at run start: the provider's adapter (which speaks
 * Loam's internal ChatOptions/ChatResult directly) wrapped so the remote id
 * is injected on every call — the run pipeline never sees the protocol.
 *
 * Credentials: resolved once per run from the registry auth scheme —
 * `none`, `env` (LOAM_* style var) or the safeStorage vault (bearer/header).
 * The key crosses no boundary it doesn't already cross for the registry's
 * own test/discover calls.
 */
import { OllamaClient } from "../../ollama.js";
import { getRegistry } from "./init.js";
import type { ModelRecord, ProviderRecord } from "./types.js";
import { createAdapter } from "../adapters/index.js";
import type { AdapterOptions } from "../adapters/types.js";
import { getVault } from "../secrets/vault.js";
import { log } from "../../log.js";

/** Ref format written by selectModel: `registry:<providerId>/<modelId>`. */
export const REGISTRY_REF_PREFIX = "registry:";

export interface RegistryModelRef {
  providerId: string;
  modelId: string;
}

/** Parse a `registry:<model.id>` ref. The registry model id already embeds
 *  its provider (`<providerId>/<remoteId>`), so `modelId` is the full id and
 *  `providerId` its first segment (kept for validation/labels). */
export function parseRegistryModelRef(model: string): RegistryModelRef | null {
  if (!model.startsWith(REGISTRY_REF_PREFIX)) return null;
  const rest = model.slice(REGISTRY_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { providerId: rest.slice(0, slash), modelId: rest };
}

/** Build the `registry:<model.id>` ref — a registry model id already carries
 *  its provider (`<providerId>/<remoteId>`), so the ref is prefix + full id. */
export function registryModelRef(modelId: string): string {
  return `${REGISTRY_REF_PREFIX}${modelId}`;
}

/** Resolve a registry model ref to its (enabled) provider + model records. */
export function resolveRegistryModel(ref: RegistryModelRef): { provider: ProviderRecord; model: ModelRecord } | null {
  const registry = getRegistry();
  if (!registry) return null;
  const model = registry.models.find((m) => m.id === ref.modelId && m.providerId === ref.providerId);
  const provider = registry.providers.find((p) => p.id === ref.providerId);
  if (!model || !provider || !model.enabled || !provider.enabled) return null;
  return { provider, model };
}

/** Resolve a provider's credential to an apiKey string (undefined = none). */
async function resolveApiKey(provider: ProviderRecord): Promise<string | undefined> {
  const auth = provider.auth;
  if (auth.type === "none") return undefined;
  if (auth.type === "env") {
    const value = process.env[auth.envVar];
    return value && value.trim() ? value.trim() : undefined;
  }
  try {
    return (await getVault().get(auth.credentialId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export interface RegistryRunClient {
  /** A real OllamaClient whose chat() is bridged to the provider adapter —
   *  the run pipeline keeps its OllamaClient type and every non-chat method
   *  (listModels etc.) falls through to the loopback client. */
  client: OllamaClient;
  /** The registry ref (provider/model) this client serves. */
  ref: string;
  /** Human label for logs. */
  label: string;
}

/**
 * Build a run-scoped chat client for a registry model ref. Returns null when
 * the model isn't a registry ref, isn't resolvable, or is NOT a native
 * protocol — openai-compatible registry picks route through the Flex slot
 * (they don't need an adapter), and ollama picks through the local client.
 */
export async function createRegistryRunClient(model: string, loopbackUrl = "http://127.0.0.1:11434"): Promise<RegistryRunClient | null> {
  const ref = parseRegistryModelRef(model);
  if (!ref) return null;
  const resolved = resolveRegistryModel(ref);
  if (!resolved) {
    log.warn(`[registry] run model ref ${model} not resolvable (disabled or missing) — falling back`);
    return null;
  }
  const { provider, model: record } = resolved;
  if (provider.kind !== "anthropic" && provider.kind !== "google-gemini") return null;

  const apiKey = await resolveApiKey(provider);
  if (provider.auth.type !== "none" && !apiKey) {
    log.warn(`[registry] ${provider.label} needs a credential (vault/env) — run would fail; check the key in Settings`);
  }
  const options: AdapterOptions = {
    baseUrl: provider.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(provider.extraHeaders && Object.keys(provider.extraHeaders).length > 0 ? { extraHeaders: provider.extraHeaders } : {}),
    timeoutMs: provider.timeoutMs,
  };
  const adapter = createAdapter(provider.kind, options);
  const remoteId = record.remoteId;
  // Bridge: only chat() is overridden; everything else stays loopback.
  const client = new OllamaClient(loopbackUrl);
  (client as unknown as { chat: OllamaClient["chat"] }).chat = (chatOptions) => adapter.chat({ ...chatOptions, model: remoteId });
  return {
    client,
    ref: registryModelRef(record.id),
    label: `${provider.label}/${remoteId}`,
  };
}
