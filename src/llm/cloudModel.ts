/**
 * Single owner of the "cloud model only" rule (moved here from the atoms-dev
 * spec §4.12 so every Core feature and App Builder share one definition).
 * The local Ollama model never qualifies; it is never used for coding,
 * planning, judging, ledgers or selection.
 */
import type { Config } from "../config.js";
import type { FailoverProvider } from "./failover.js";
import { providerForModel } from "./router.js";

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

export function isCloudProvider(model: string, p: Pick<FailoverProvider, "kind" | "baseUrl" | "enabled"> | undefined): boolean {
  if (!model) return false;
  if (model.endsWith(":cloud")) return true;
  if (!p || !p.enabled) return false;
  if (p.kind === "ollama") return false;
  try {
    return !LOCAL_HOSTS.test(new URL(p.baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isCloudModel(cfg: Config, model: string): boolean {
  return isCloudProvider(model, providerForModel(cfg, model));
}

/** A cloud request is still cloud when the provider echoes the id without `:cloud`.
 *  `glm-5.3-flash:cloud` often comes back as `glm-5.3`. A different local model does not. */
export function isCloudResponse(cfg: Config, requested: string, returned: string): boolean {
  if (isCloudModel(cfg, returned)) return true;
  if (!requested.endsWith(":cloud")) return false;
  const asked = requested.slice(0, -":cloud".length);
  if (!asked || !returned || returned.endsWith(":latest")) return false;
  return asked === returned || asked.startsWith(`${returned}-`) || asked.startsWith(`${returned}:`);
}

export class NoCloudModelError extends Error {
  readonly code = "no_cloud_model";
  constructor(feature: string) {
    super(`no_cloud_model: ${feature} needs a cloud model. Set one under Settings > Models.`);
    this.name = "NoCloudModelError";
  }
}

/** First cloud model among the candidates, in order; throws when none is cloud. */
export function pickCloudModel(cfg: Config, feature: string, candidates: Array<string | undefined>): string {
  for (const m of candidates) if (m && isCloudModel(cfg, m)) return m;
  throw new NoCloudModelError(feature);
}
