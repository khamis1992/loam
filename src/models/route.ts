/**
 * UI-task model routing (V14).
 *
 * A UI task is routed to the strongest model that can actually serve it. This
 * module owns no provider knowledge of its own: it reads the caller's coding
 * chain and the real failover providers (`src/llm/failover.ts`) and reuses the
 * existing resolvers in `src/llm/codingRouter.ts`, so a UI task is routed by the
 * same rules a coding turn already uses. Nothing here can drift from the coding
 * router, because there is only one implementation of "which model is strongest
 * and available".
 *
 * The rule that matters is the negative one. A model id with no live provider is
 * not a stronger choice; it is a model that cannot be served, so routing to it
 * would turn a strong UI task into a failed request. "Available" means what the
 * coding router already means by it: the provider is enabled, and a cloud
 * provider holds a usable credential (`hasUsableKey`, which reads the key from
 * the environment by `apiKeyEnv` name). A provider that is cooling down is
 * skipped too, when the caller supplies the cooldown store.
 *
 * This module is pure: no network, no filesystem, no clock of its own. The clock
 * and the cooldown store are injectable, which is what the routing tests use.
 */
import type { Config } from "../config.js";
import { coderChainIds, codingProviders, usableProviders } from "../llm/codingRouter.js";
import { providerKey, type CooldownStore, type FailoverProvider } from "../llm/failover.js";

export type { FailoverProvider };

/** A resolved route: the model to call and why it was chosen. */
export interface UiModelRoute {
  /** The model id a UI task should call. */
  model: string;
  /** Provider id that will serve it, empty when the route is not provider-bound. */
  provider: string;
  /** Every provider id that may serve the model, strongest first. */
  chain: string[];
  /**
   * The decision that produced the route.
   *
   * - `coding` — the configured coding chain named this model.
   * - `strongest` — no usable chain match; the strongest available provider won.
   * - `default` — nothing is available, so the configured model stands.
   */
  source: "coding" | "strongest" | "default";
}

/** The slice of app config the router reads. */
export interface UiRouteConfig {
  /** The configured model; used when nothing stronger can be served. */
  model: string;
  /** Ordered model ids from the coding config, strongest first. */
  chain?: string[];
  /** The real failover providers, in strength order. */
  providers?: FailoverProvider[];
  /** Environment the credential lookup reads; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Cooldown store, so a provider that is backing off is not chosen. */
  store?: CooldownStore;
  /** Injectable clock, so a test can assert cooldown handling. */
  now?: () => number;
}

/**
 * Present the router's slice as the `Config` shape the coding resolvers read.
 *
 * The cast is deliberate: `coderChainIds` and `codingProviders` only read
 * `model`, `coding.chain` and `failover.providers`, so this is a narrower view of
 * the real config rather than a second definition of it. Going through the real
 * resolvers is the point — a parallel implementation is what would let UI routing
 * and coding routing disagree about which provider is usable.
 */
function asConfig(cfg: UiRouteConfig, model: string): Config {
  return {
    model,
    coding: { enabled: true, chain: cfg.chain ?? [] },
    failover: { providers: cfg.providers ?? [] },
  } as unknown as Config;
}

/** True when the provider is inside its cooldown window. */
function isCooling(provider: FailoverProvider, store: CooldownStore | undefined, now: number): boolean {
  if (!store) return false;
  const entry = store.get(providerKey(provider));
  return entry !== undefined && entry.expiresAt > now;
}

/**
 * Why the route came out the way it did.
 *
 * A chain was configured when the resolver reports `env` or `config`. Even then
 * the chosen provider only counts as `coding` when the chain actually named it:
 * the resolver falls back to the whole available list when no chain entry can be
 * served, and calling that a chain decision would overstate what happened.
 */
function routeSource(fromChain: boolean, chainIds: string[], chosen: FailoverProvider): UiModelRoute["source"] {
  if (!fromChain) return "strongest";
  const named = chainIds.some((id) => id.trim().toLowerCase() === chosen.model.trim().toLowerCase());
  return named ? "coding" : "strongest";
}

/**
 * Pick the model for a UI task.
 *
 * Preference order, all resolved by the existing coding router:
 *  1. the first entry of the coding chain that a provider can actually serve;
 *  2. the strongest available provider, when no chain entry can be served;
 *  3. the configured model, when nothing is available.
 */
export function routeUiModel(cfg: UiRouteConfig | undefined): UiModelRoute {
  const configured = (cfg?.model ?? "").trim() || "local";
  const env = cfg?.env ?? process.env;
  const now = (cfg?.now ?? Date.now)();
  const config = asConfig({ ...(cfg ?? { model: configured }) }, configured);

  const chain = coderChainIds(config, env);
  // `usableProviders` is the full available catalogue; `codingProviders` is the
  // chain-preferred subset of it. The preference decides the model, but the chain
  // reported back must list *every* provider that can serve that model, otherwise
  // failover would lose its remaining candidates.
  const usable = usableProviders(config, env).filter((provider) => !isCooling(provider, cfg?.store, now));
  const preferred = codingProviders(config, env).filter((provider) => !isCooling(provider, cfg?.store, now));

  if (usable.length === 0) {
    return { model: configured, provider: "", chain: [], source: "default" };
  }

  const chosen = preferred[0] ?? usable[0]!;
  const fromChain = chain.source === "env" || chain.source === "config";
  return {
    model: chosen.model,
    provider: chosen.id,
    // Every provider that can serve the chosen model, strongest first.
    chain: usable.filter((provider) => provider.model === chosen.model).map((provider) => provider.id),
    source: routeSource(fromChain, chain.ids, chosen),
  };
}

export default routeUiModel;
