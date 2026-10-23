/**
 * UI-task model routing (V14).
 *
 * A UI task is routed to the strongest model that can actually serve it. The
 * pipeline never invents a model: it reads the caller's coding chain (model ids
 * ordered strongest-first) and the failover providers, keeps only providers that
 * are enabled and usable, and picks the first model both lists agree on.
 *
 * The rule that matters is the negative one. A model id with no live provider is
 * not a stronger choice; it is a model that cannot be served, so routing to it
 * would turn a strong UI task into a failed request. When nothing is configured
 * the run stays on the configured model, which is always servable.
 *
 * This module is pure: no network, no filesystem, no clock. A caller can inject
 * a provider catalogue and assert the decision, which is what the routing tests
 * do.
 */

/** One model a provider may serve, with the strength the caller assigned it. */
export interface UiModelProvider {
  /** Provider id, unique per provider. */
  id: string;
  /** Model id this provider serves. */
  model: string;
  /** Whether the provider is enabled. */
  enabled?: boolean;
  /** Whether the provider currently holds a usable credential. */
  hasKey?: boolean;
  /** Cooldown or failure cooldown timestamp in ms; undefined means healthy. */
  cooldownUntil?: number;
  /** Relative strength; higher is stronger. Unset means unknown. */
  strength?: number;
}

/** A resolved route: the model to call and why it was chosen. */
export interface UiModelRoute {
  /** The model id a UI task should call. */
  model: string;
  /** Provider id that will serve it, empty when the route is not provider-bound. */
  provider: string;
  /** Every provider id that may serve the model, strongest first. */
  chain: string[];
  /** The decision that produced the route. */
  source: "coding" | "strongest" | "default";
}

/** The slice of app config the router reads. */
export interface UiRouteConfig {
  /** The configured model; used when nothing stronger can be served. */
  model: string;
  /** Ordered provider ids from the coding config, strongest first. */
  chain?: string[];
  /** Providers that may be consulted, strongest last in the coding order. */
  providers?: UiModelProvider[];
  /** Injectable clock, so a test can assert cooldown handling. */
  now?: () => number;
}

function usableProviders(providers: UiModelProvider[], now: number): UiModelProvider[] {
  return providers.filter((provider) => {
    if (provider.enabled === false) return false;
    if (provider.hasKey === false) return false;
    if (provider.cooldownUntil !== undefined && provider.cooldownUntil > now) return false;
    return provider.model.trim().length > 0;
  });
}

/**
 * Pick the model for a UI task.
 *
 * Preference order:
 *  1. the first usable model that appears in the coding chain (the caller's
 *     own strength order);
 *  2. the strongest usable provider model, when the coding chain is empty;
 *  3. the configured model.
 */
export function routeUiModel(cfg: UiRouteConfig | undefined): UiModelRoute {
  const configured = (cfg?.model ?? "").trim() || "local";
  const now = (cfg?.now ?? Date.now)();
  const chain = (cfg?.chain ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  const usable = usableProviders(cfg?.providers ?? [], now);

  if (chain.length === 0) {
    if (usable.length === 0) return { model: configured, provider: "", chain: [], source: "default" };
    const strongest = usable.reduce((best, candidate) => {
      const bestStrength = best.strength ?? -Infinity;
      const candidateStrength = candidate.strength ?? -Infinity;
      return candidateStrength > bestStrength ? candidate : best;
    });
    return { model: strongest.model, provider: strongest.id, chain: [strongest.id], source: "strongest" };
  }

  for (const model of chain) {
    const match = usable.find((provider) => provider.model === model);
    if (match) {
      return {
        model,
        provider: match.id,
        chain: usable.filter((provider) => provider.model === model).map((provider) => provider.id),
        source: "coding",
      };
    }
  }
  // A chain entry with no live provider must not be used.
  return { model: configured, provider: "", chain: [], source: "default" };
}

export default routeUiModel;
