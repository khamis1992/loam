/**
 * Model tiers (option 18): Max / Standard / Lite / Flex.
 *
 * The UI composer shows tiers, never raw model names. This module maps a tier
 * to a concrete model id from the existing config/settings defaults. Flex is
 * bring-your-own-key: the API key lives encrypted in the secrets vault under a
 * dedicated scope and the value is only ever resolved server-side, at the
 * boundary where the run's model client is built. It is never returned by any
 * route and never enters prompts, logs or model context.
 */
import { getSettings, updateSettings, type Settings } from "./settings.js";
import { setSecret, deleteSecret, resolveSecret, listSecrets } from "./secretsVault.js";
import type { Config } from "../config.js";

export const MODEL_TIERS = ["max", "standard", "lite", "flex"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Vault scope + secret name used for the Flex API key. */
export const FLEX_SCOPE = "model-tiers";
export const FLEX_KEY_NAME = "flex-key";

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

/** Public shape of the Flex configuration — the key itself never appears. */
export interface FlexPublicConfig {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export function flexConfig(): FlexPublicConfig {
  const settings = getSettings();
  return {
    baseUrl: settings.flexBaseUrl ?? "",
    model: settings.flexModel ?? "",
    hasKey: listSecrets(FLEX_SCOPE).some((s) => s.name === FLEX_KEY_NAME),
  };
}

/** Store/update Flex settings. `key` (when non-empty) is sealed in the vault;
 *  an empty-string `key` clears it. Returns the public projection only. */
export function setFlexConfig(body: { key?: unknown; baseUrl?: unknown; model?: unknown }): { ok: true; flex: FlexPublicConfig } | { error: string } {
  const patch: Settings = { theme: getSettings().theme };
  if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
    const url = body.baseUrl.trim();
    if (!/^https?:\/\//i.test(url)) return { error: "baseUrl must start with http:// or https://" };
    patch.flexBaseUrl = url.slice(0, 300);
  }
  if (typeof body.model === "string") {
    patch.flexModel = body.model.trim().slice(0, 120);
  }
  if (patch.flexBaseUrl !== undefined || patch.flexModel !== undefined) updateSettings(patch);
  if (typeof body.key === "string") {
    if (body.key === "") {
      deleteSecret(FLEX_SCOPE, FLEX_KEY_NAME);
    } else if (body.key.trim()) {
      const stored = setSecret(FLEX_SCOPE, FLEX_KEY_NAME, body.key.trim());
      if (stored !== true) return stored;
    }
  }
  return { ok: true, flex: flexConfig() };
}

export function clearFlexKey(): boolean {
  return deleteSecret(FLEX_SCOPE, FLEX_KEY_NAME);
}

/** Server-side resolution for the run boundary. NEVER expose to the client. */
export function flexCredentials(): { baseUrl: string; apiKey: string; model: string } | null {
  const pub = flexConfig();
  if (!pub.baseUrl || !pub.hasKey) return null;
  const apiKey = resolveSecret(FLEX_SCOPE, FLEX_KEY_NAME);
  if (!apiKey) return null;
  return { baseUrl: pub.baseUrl, apiKey, model: pub.model };
}

export interface TierResolution {
  /** Concrete model id for the run. Flex ids carry the ":cloud" suffix. */
  model: string;
  /** True when the run needs the Flex provider override (own baseUrl + key). */
  flex: boolean;
}

/** Map a tier to a concrete model id using existing config/settings defaults. */
export function resolveTierModel(cfg: Config, tier: ModelTier): TierResolution {
  const settings = getSettings();
  switch (tier) {
    case "max":
      return { model: cfg.model, flex: false };
    case "standard":
      return { model: settings.model && settings.model.trim() ? settings.model.trim() : cfg.model, flex: false };
    case "lite":
      return { model: cfg.fallbackModel && cfg.fallbackModel.trim() ? cfg.fallbackModel.trim() : cfg.model, flex: false };
    case "flex": {
      const pub = flexConfig();
      const id = pub.model.trim();
      if (!id) return { model: cfg.model, flex: false };
      const cloud = id.endsWith(":cloud") ? id : `${id}:cloud`;
      return { model: cloud, flex: true };
    }
  }
}
