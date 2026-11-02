/**
 * Model directory (real model selection).
 *
 * Loam ships no models of its own: every run goes through Ollama (local), a
 * cloud provider (OpenAI-compatible), or a self-hosted router such as
 * freellmapi. This module aggregates what is actually reachable RIGHT NOW so
 * the picker can offer real model ids instead of fictional tier names.
 *
 * Sources, in order:
 *  - Ollama at `cfg.ollamaUrl` (`/api/tags`) — local models.
 *  - The Flex BYOK slot (settings + vault key) when configured.
 *  - `cfg.cloudModel` (OpenAI-compatible) when it has a key.
 *  - Every `failover.providers` entry (openai-compatible ones are probed at
 *    `<baseUrl>/models`; the freellmapi router at localhost:31415 is included
 *    even though the failover chain keeps it disabled — availability is probed
 *    live, so the router shows up exactly when the user runs it).
 *
 * Probes are parallel, individually timeout-bounded and never throw: a down
 * provider yields an empty source with the error recorded, not a failed list.
 *
 * Security: every probed URL must be http(s). Loopback/private hosts are
 * deliberately allowed — self-hosted providers ARE the feature (Ollama,
 * freellmapi, LM Studio all live on localhost); the endpoints all come from
 * server-side config (DEFAULTS or the user's own config.json), never from
 * request parameters.
 */
import type { Config } from "../config.js";
import { clearFlexKey, flexConfig, flexCredentials, setFlexConfig } from "./modelTiers.js";
import { getSettings, updateSettings, type Settings } from "./settings.js";
import { getRegistry } from "../models/registry/init.js";
import { saveRegistry } from "../models/registry/store.js";
import { registryModelRef } from "../models/registry/registryClient.js";
import type { ModelCapabilities, ProviderRecord } from "../models/registry/types.js";
import { getVault } from "../models/secrets/vault.js";
import { log } from "../log.js";

/** Public provider presets the Flex form offers as one-tap fills. */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  keyEnv: string;
  /** Arabic hint shown when the key is missing. */
  setupAr: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "freellmapi",
    label: "freellmapi (موجّه ذاتي)",
    baseUrl: "http://127.0.0.1:31415/v1",
    keyEnv: "FREELLM_API_KEY",
    setupAr: "شغّل موجّه freellmapi محليًا (github.com/tashfeenahmed/freellmapi) ثم أدخل مفتاحه أو اتركه فارغًا إن كان بلا مفتاح.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    setupAr: "أنشئ مفتاح OpenRouter من openrouter.ai/settings/keys وأدخله هنا.",
  },
  {
    id: "longcat",
    label: "LongCat",
    baseUrl: "https://api.longcat.chat/openai/v1",
    keyEnv: "LONGCAT_API_KEY",
    setupAr: "أدخل مفتاح LongCat من منصة LongCat API.",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    keyEnv: "OPENCODE_API_KEY",
    setupAr: "أدخل مفتاح OpenCode (خدمة Go) من حسابك في opencode.ai.",
  },
];

export type ModelKind = "ollama" | "openai-compatible";

export interface ModelEntry {
  /** Model id as passed to the provider. */
  id: string;
  /** Legacy-compatible name (old consumers read `.name`). */
  name: string;
  /** Source id: "ollama" | "flex" | "cloud" | failover provider id. */
  source: string;
  kind: ModelKind;
}

export interface SourceState {
  source: string;
  label: string;
  kind: ModelKind;
  baseUrl?: string;
  /** Present when the source was probed and failed. */
  error?: string;
  count: number;
}

export interface ModelDirectory {
  models: ModelEntry[];
  sources: SourceState[];
}

/** Saved registry models for GET /api/models `entries`. No secrets. */
export interface RegistryDirectoryEntry {
  id: string;
  label: string;
  providerId: string;
  location: "local" | "cloud";
  enabled: boolean;
  capabilities: ModelCapabilities;
}

export function registryModelEntries(): RegistryDirectoryEntry[] {
  const registry = getRegistry();
  if (!registry) return [];
  return registry.models.map((model) => {
    const provider = registry.providers.find((item) => item.id === model.providerId);
    return {
      id: model.id,
      label: model.label,
      providerId: model.providerId,
      location: provider?.location ?? "local",
      enabled: model.enabled,
      capabilities: model.capabilities,
    };
  });
}

/** Test seam: replace the directory's fetch (defaults to global fetch). */
let fetcher: typeof fetch = (input, init) => fetch(input, init);

export function __setFetcherForTests(next?: typeof fetch): void {
  fetcher = next ?? ((input, init) => fetch(input, init));
}

function assertHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported scheme: ${url.protocol}`);
  }
  return url;
}

/** Probe one OpenAI-compatible `/models` endpoint. Never throws. */
async function probeOpenAiModels(baseUrl: string, apiKey: string | undefined, timeoutMs = 4_000): Promise<{ ids: string[]; error?: string }> {
  try {
    const base = assertHttpUrl(baseUrl).href;
    const modelsUrl = new URL("models", base.endsWith("/") ? base : `${base}/`);
    const res = await fetcher(modelsUrl, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ids: [], error: `HTTP ${res.status}` };
    const data = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
    const ids = [...(data.data ?? []), ...(data.models ?? [])].map((m) => (m.id ?? "").trim()).filter(Boolean);
    return { ids: [...new Set(ids)] };
  } catch (err) {
    return { ids: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read an env-var API key (failover providers reference keys by env name). */
function envKey(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * Aggregate every reachable model source. `ollamaModels` is injected so callers
 * reuse the live client (and tests can stub it).
 */
export async function listModelDirectory(
  cfg: Config,
  ollamaModels: () => Promise<string[]>,
): Promise<ModelDirectory> {
  const models: ModelEntry[] = [];
  const sources: SourceState[] = [];

  // 1) Ollama (local).
  try {
    const ids = await ollamaModels();
    sources.push({ source: "ollama", label: "Ollama (محلي)", kind: "ollama", baseUrl: cfg.ollamaUrl, count: ids.length });
    for (const id of ids) models.push({ id, name: id, source: "ollama", kind: "ollama" });
  } catch (err) {
    sources.push({ source: "ollama", label: "Ollama (محلي)", kind: "ollama", baseUrl: cfg.ollamaUrl, error: err instanceof Error ? err.message : String(err), count: 0 });
  }

  // 2) Flex BYOK slot.
  const flex = flexCredentials();
  if (flex?.baseUrl) {
    const probed = await probeOpenAiModels(flex.baseUrl, flex.apiKey || undefined);
    sources.push({
      source: "flex", label: `Flex: ${flex.baseUrl}`, kind: "openai-compatible", baseUrl: flex.baseUrl,
      ...(probed.error ? { error: probed.error } : {}), count: probed.ids.length,
    });
    for (const id of probed.ids) models.push({ id, name: id, source: "flex", kind: "openai-compatible" });
  }

  // 3) cloudModel section (OpenAI-compatible), only with a key.
  const cloudBase = cfg.cloudModel?.baseUrl?.trim();
  const cloudKey = cfg.cloudModel?.apiKey?.trim();
  if (cloudBase) {
    const probed = await probeOpenAiModels(cloudBase, cloudKey || undefined);
    sources.push({
      source: "cloud", label: `سحابي: ${cloudBase}`, kind: "openai-compatible", baseUrl: cloudBase,
      ...(probed.error ? { error: probed.error } : {}), count: probed.ids.length,
    });
    for (const id of probed.ids) models.push({ id, name: id, source: "cloud", kind: "openai-compatible" });
  }

  // 4) Failover providers — all of them, including disabled ones (freellmapi is
  //    disabled in the failover chain by default but must still be selectable
  //    when the user runs the router; the live probe decides).
  const providers = cfg.failover?.providers ?? [];
  await Promise.all(providers.map(async (provider) => {
    if (provider.kind !== "openai-compatible") return;
    const key = envKey(provider.apiKeyEnv);
    const probed = await probeOpenAiModels(provider.baseUrl, key);
    sources.push({
      source: provider.id, label: `${provider.id} (${provider.baseUrl})`, kind: "openai-compatible", baseUrl: provider.baseUrl,
      ...(probed.error ? { error: probed.error } : {}), count: probed.ids.length,
    });
    for (const id of probed.ids) models.push({ id, name: id, source: provider.id, kind: "openai-compatible" });
  }));

  // 5) Model registry (PR #4): providers the user added from Settings, with
  //    their stored models — no probing needed, the registry already knows
  //    them (its own Discover filled the list). Endpoints already surfaced
  //    above through failover are skipped: same base URL is the same choice.
  const registry = getRegistry();
  const coveredEndpoints = new Set(sources.map((s) => (s.baseUrl ?? "").replace(/\/+$/, "")));
  for (const provider of registry?.providers ?? []) {
    if (!provider.enabled) continue;
    const endpoint = provider.baseUrl.replace(/\/+$/, "");
    if (coveredEndpoints.has(endpoint)) continue;
    coveredEndpoints.add(endpoint);
    const listed = (registry?.models ?? []).filter((m) => m.providerId === provider.id && m.enabled);
    const source = `registry:${provider.id}`;
    sources.push({
      source, label: `سجل: ${provider.label}`, kind: provider.kind === "ollama" ? "ollama" : "openai-compatible",
      baseUrl: provider.baseUrl, count: listed.length,
    });
    for (const m of listed) {
      models.push({ id: m.remoteId, name: m.remoteId, source, kind: provider.kind === "ollama" ? "ollama" : "openai-compatible" });
    }
  }

  // De-duplicate: same model id behind the same endpoint twice (the Flex slot
  // pointing at the freellmapi router AND the freellmapi provider entry) is one
  // choice, not two rows. Distinct endpoints keep their own rows — the source
  // is part of the choice.
  const endpointOf = new Map(sources.map((s) => [s.source, (s.baseUrl ?? s.source).replace(/\/+$/, "")]));
  const seen = new Set<string>();
  const unique = models.filter((m) => {
    const key = `${endpointOf.get(m.source) ?? m.source}::${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (sources.some((s) => s.error)) {
    log.info(`model directory: ${unique.length} model(s); unreachable sources: ${sources.filter((s) => s.error).map((s) => s.source).join(", ")}`);
  }
  return { models: unique, sources };
}

export interface ActiveModel {
  /** What a new run uses today (config model with the :cloud marker). */
  model: string;
  /** The standard-tier model (settings.model when set). */
  settingsModel: string;
  flex: ReturnType<typeof flexConfig>;
}

export function activeModel(cfg: Config): ActiveModel {
  return { model: cfg.model, settingsModel: getSettings().model ?? "", flex: flexConfig() };
}

export interface SelectResult {
  ok: true;
  /** Tier the UI should switch to: local picks run as "standard". */
  tier: "standard" | "flex";
  model: string;
  /** True when the cloud pick has no key yet (runs would fail until set). */
  needsKey: boolean;
}

/** Write a registry ref so the run uses this provider's adapter and its own key. */
async function selectViaRegistry(
  registry: NonNullable<ReturnType<typeof getRegistry>>,
  provider: ProviderRecord,
  remoteId: string,
): Promise<SelectResult | { ok: false; error: string }> {
  const record = registry.models.find((m) => m.providerId === provider.id && m.remoteId === remoteId && m.enabled);
  if (!record) return { ok: false, error: `نموذج غير معروف أو معطّل لهذا المزوّد: ${remoteId}` };
  const model = registryModelRef(record.id);
  updateSettings({ theme: getSettings().theme, model });
  setRegistryDefault(registry, record.id);
  const needsKey = provider.auth.type !== "none" && !(await registryProviderHasKey(provider));
  return { ok: true, tier: "standard", model, needsKey };
}

/** Apply a real-model pick: local models go to settings.model; cloud/provider
 *  models are routed through the Flex slot (its key stays whatever the vault
 *  or the provider's env var provides). Registry providers (PR #4) resolve
 *  their credential through the registry vault, so the key check is async. */
export async function selectModel(cfg: Config, input: { id: unknown; source: unknown }): Promise<SelectResult | { ok: false; error: string }> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const source = typeof input.source === "string" ? input.source.trim() : "";
  if (!id) return { ok: false, error: "id is required" };
  if (id.length > 200) return { ok: false, error: "id too long" };

  if (source === "ollama" || source === "") {
    const patch: Settings = { theme: getSettings().theme, model: id };
    updateSettings(patch);
    clearRegistryDefault();
    return { ok: true, tier: "standard", model: id, needsKey: false };
  }

  // Cloud-side pick: resolve the provider baseUrl (+ key presence) per source.
  let baseUrl = "";
  let keyEnv = "";
  let registryHasKey = false;
  if (source.startsWith("registry:")) {
    const registry = getRegistry();
    const provider = registry?.providers.find((p) => `registry:${p.id}` === source);
    if (!provider) return { ok: false, error: `unknown registry provider: ${source}` };
    if (provider.kind === "anthropic" || provider.kind === "google-gemini") {
      return selectViaRegistry(registry!, provider, id);
    }
    if (provider.kind === "ollama") {
      const same = provider.baseUrl.replace(/\/+$/, "") === cfg.ollamaUrl.replace(/\/+$/, "");
      if (same) {
        const patch: Settings = { theme: getSettings().theme, model: id };
        updateSettings(patch);
        clearRegistryDefault();
        return { ok: true, tier: "standard", model: id, needsKey: false };
      }
      return selectViaRegistry(registry!, provider, id);
    }
    if (provider.auth.type !== "none") {
      return selectViaRegistry(registry!, provider, id);
    }
    baseUrl = provider.baseUrl;
    registryHasKey = await registryProviderHasKey(provider);
  } else if (source === "flex" || source === "cloud") {
    baseUrl = source === "flex" ? (flexConfig().baseUrl || "") : (cfg.cloudModel?.baseUrl ?? "");
  } else {
    const provider = (cfg.failover?.providers ?? []).find((p) => p.id === source);
    const preset = PROVIDER_PRESETS.find((p) => p.id === source);
    baseUrl = provider?.baseUrl ?? preset?.baseUrl ?? "";
    keyEnv = provider?.apiKeyEnv ?? preset?.keyEnv ?? "";
  }
  if (!baseUrl) return { ok: false, error: `unknown model source: ${source}` };

  // Switching providers must never forward the previous provider's sealed key
  // to the new one: clear it unless the new provider has its own env key.
  const flexNow = flexConfig();
  const providerHasKey = registryHasKey || Boolean(envKey(keyEnv));
  const switchingProvider = flexNow.baseUrl !== baseUrl;
  if (switchingProvider && flexNow.hasKey && !providerHasKey) clearFlexKey();

  const stored = setFlexConfig({ baseUrl, model: id });
  if (!("ok" in stored) || !stored.ok) return { ok: false, error: "error" in stored ? stored.error : "flex save failed" };
  clearRegistryDefault();
  const runModel = `${id}:cloud`;
  updateSettings({ theme: getSettings().theme, model: runModel });
  const hasKey = providerHasKey || (!switchingProvider && flexNow.hasKey);
  return { ok: true, tier: "flex", model: runModel, needsKey: !hasKey };
}

/** Make a registry model the default: defaultModelId + head of the default
 *  chain (the registry is the single source of truth for native-protocol
 *  routing; the settings.model ref is what the run pipeline reads). */
function setRegistryDefault(registry: NonNullable<ReturnType<typeof getRegistry>>, modelId: string): void {
  try {
    registry.defaultModelId = modelId;
    const chain = registry.chains.find((c) => c.id === "default");
    if (chain) {
      chain.modelIds = [modelId, ...chain.modelIds.filter((m) => m !== modelId)];
    } else {
      registry.chains.push({ id: "default", label: "Default", modelIds: [modelId] });
    }
    saveRegistry(registry);
  } catch (err) {
    log.warn(`registry default not saved: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Any non-registry pick clears the registry default — one active primary. */
function clearRegistryDefault(): void {
  try {
    const registry = getRegistry();
    if (registry?.defaultModelId) {
      registry.defaultModelId = null;
      saveRegistry(registry);
    }
  } catch {
    /* registry absent — nothing to clear */
  }
}

/** Resolve a registry provider's key for the needsKey check only — the actual
 *  call-time credential stays in the registry vault; nothing is copied. */
async function registryProviderHasKey(provider: ProviderRecord): Promise<boolean> {
  const auth = provider.auth;
  if (auth.type === "none") return true;
  if (auth.type === "env") return Boolean(envKey(auth.envVar));
  try {
    const vault = getVault();
    return (await vault.get(auth.credentialId)) !== undefined;
  } catch {
    return false;
  }
}
