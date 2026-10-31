/**
 * Client service for the model-tier picker's Flex (bring-your-own-key) config
 * (UNIMPLEMENTED_OPTIONS #18 tail).
 *
 * The Flex API key is a secret: it is sent to the backend once, sealed into the
 * Loam secrets vault (AES-256-GCM), and never echoed back. These wrappers are the
 * only place the web app touches that key, and every call degrades gracefully so
 * the model dropdown keeps its previous state when the backend is unreachable.
 */
import { getApiBase, getApiHeaders } from './rpc';

export interface FlexConfig {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

/**
 * GET /api/model-tiers — the Flex projection. The key itself is never returned;
 * `hasKey` is the only signal the UI needs to show the saved-key badge.
 */
export async function fetchFlexConfig(): Promise<FlexConfig | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/model-tiers`, { headers: await getApiHeaders() });
    if (!res.ok) return null;
    const data = (await res.json()) as { flex?: FlexConfig };
    return data.flex ?? null;
  } catch {
    return null;
  }
}

/**
 * PUT /api/model-tiers/flex — store the provider base URL, model id and (when
 * non-blank) the API key. A blank `key` keeps the currently sealed key.
 */
export async function saveFlexConfig(input: {
  baseUrl: string;
  model: string;
  key?: string;
}): Promise<{ flex?: FlexConfig; error?: string }> {
  try {
    const body: Record<string, string> = { baseUrl: input.baseUrl, model: input.model };
    if (input.key && input.key.trim()) body.key = input.key.trim();
    const res = await fetch(`${getApiBase()}/api/model-tiers/flex`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; flex?: FlexConfig };
    if (!res.ok) return { error: data.error ?? `status ${res.status}` };
    return { flex: data.flex };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** DELETE /api/model-tiers/flex/key — remove the sealed key from the vault. */
export async function removeFlexKey(): Promise<{ flex?: FlexConfig; error?: string }> {
  try {
    const res = await fetch(`${getApiBase()}/api/model-tiers/flex/key`, {
      method: 'DELETE',
      headers: await getApiHeaders(),
    });
    const data = (await res.json().catch(() => ({}))) as { flex?: FlexConfig };
    if (!res.ok) return { error: `status ${res.status}` };
    return { flex: data.flex };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- real model directory (cloud / Ollama / local) ----

/** One selectable model as reported by GET /api/models. */
export interface ModelEntry {
  id: string;
  /** Legacy-compatible name field (old consumers read `.name`). */
  name: string;
  source: string;
  kind: 'ollama' | 'openai-compatible';
}

export interface ModelSource {
  source: string;
  label: string;
  kind: 'ollama' | 'openai-compatible';
  baseUrl?: string;
  error?: string;
  count: number;
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  keyEnv: string;
  setupAr: string;
}

export interface ModelDirectory {
  models: ModelEntry[];
  sources: ModelSource[];
  presets: ProviderPreset[];
  active: { model: string; settingsModel: string; flex: FlexConfig };
}

/**
 * GET /api/models — the aggregated directory (Ollama + Flex + cloud +
 * failover providers, probed live). Returns null when unreachable so the menu
 * keeps its tiers-only shape instead of breaking.
 */
export async function fetchModelDirectory(): Promise<ModelDirectory | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/models`, { headers: await getApiHeaders() });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ModelDirectory>;
    if (!Array.isArray(data.models)) return null;
    return {
      models: data.models,
      sources: data.sources ?? [],
      presets: data.presets ?? [],
      active: data.active ?? { model: '', settingsModel: '', flex: { baseUrl: '', model: '', hasKey: false } },
    };
  } catch {
    return null;
  }
}

/**
 * PUT /api/model — apply a real-model pick: local models go to the standard
 * slot, cloud/provider models route through Flex. The tier the UI should
 * switch to comes back in `tier`.
 */
export async function selectModel(input: { id: string; source: string }): Promise<
  | { ok: true; tier: 'standard' | 'flex'; model: string; needsKey: boolean; active: ModelDirectory['active'] }
  | { error: string }
> {
  try {
    const res = await fetch(`${getApiBase()}/api/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; tier?: 'standard' | 'flex'; model?: string; needsKey?: boolean; active?: ModelDirectory['active'] };
    if (!res.ok) return { error: data.error ?? `status ${res.status}` };
    return {
      ok: true,
      tier: data.tier ?? 'standard',
      model: data.model ?? input.id,
      needsKey: data.needsKey === true,
      active: data.active ?? { model: '', settingsModel: '', flex: { baseUrl: '', model: '', hasKey: false } },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
