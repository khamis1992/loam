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
