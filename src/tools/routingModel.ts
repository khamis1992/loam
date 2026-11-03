/**
 * Neo N10: resolve one call's model through the routing map.
 *
 * The composer sends an output type and an effort level with every run. Both are
 * resolved by `resolveRouting()` (`src/llm/router.ts`) into a concrete model plus
 * the ordered providers that may serve it; the failover walk, the per-provider
 * cooldowns and the provider clients stay where they already were
 * (`src/llm/failover.ts`). Nothing here talks to a network: the client factory is
 * injectable so tests can drive routing with a fake.
 */
import type { Config } from "../config.js";
import {
  resolveRouting,
  routingLabel,
  type EffortLevel,
  type OutputType,
  type RoutingPlan,
} from "../llm/router.js";
import { chatWithFailover } from "../llm/failover.js";
import type { FailoverProvider, CooldownStore, ProviderClient } from "../llm/failover.js";
import { chatWithFallback } from "../agent/model.js";
import type { ChatMessage, ChatResult, OllamaClient, OllamaFunctionTool } from "../ollama.js";
import { log } from "../log.js";

export interface RoutingCallOptions {
  cfg: Config;
  /** Client used when no provider chain is configured (local Ollama). */
  ollama: OllamaClient;
  messages: ChatMessage[];
  tools?: OllamaFunctionTool[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onThinking?: (text: string) => void;
  onRoute?: (info: { model: string; chain: string[]; providerId?: string }) => void;
  /** Internal seam for tests: environment used for keys and the env overrides. */
  env?: Record<string, string | undefined>;
  /** Internal seam for tests: in-memory cooldowns. */
  store?: CooldownStore;
  /** Internal seam for tests: build one provider client. */
  createClient?: (provider: FailoverProvider) => ProviderClient;
  outputType?: OutputType | "";
  effort?: EffortLevel | "";
  /** Tool about to be called; picks the per-tool entry when one is configured. */
  tool?: string;
  /** Explicit model override (a tool's declared model, or a run's pinned model). */
  model?: string;
  notify?: (message: string) => void;
  /** Enable thinking mode for local models (default: false for Ollama). */
  think?: boolean;
  /** Mark the system prefix as a provider cache breakpoint. */
  cacheControl?: boolean;
}

/**
 * Resolve and perform one model call honouring the routing map.
 *
 * An explicit `model` is the call: it is never replaced by the per-tool entry,
 * the effort entry, or the coding chain. With no explicit model, precedence is
 * the per-tool entry, then the effort entry, then the coding chain. An empty
 * map keeps the plain Ollama client, exactly as before N10.
 */
export async function chatWithRouting(options: RoutingCallOptions): Promise<ChatResult> {
  const env = options.env ?? process.env;
  // The model the user picked is the model that answers. A coding chain, an
  // effort entry, or a per-tool entry must not replace it with another provider.
  const explicit = options.model?.trim() ?? "";
  if (explicit) {
    options.onRoute?.({ model: explicit, chain: [explicit] });
    return chatWithFallback({
      cfg: options.cfg,
      ollama: options.ollama,
      model: explicit,
      messages: options.messages,
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onToken ? { onToken: options.onToken } : {}),
      ...(options.onThinking ? { onThinking: options.onThinking } : {}),
      notify: options.notify,
      think: options.think,
      ...(options.cacheControl ? { cacheControl: true } : {}),
    });
  }
  const plan: RoutingPlan = resolveRouting({
    cfg: options.cfg,
    env,
    ...(options.outputType ? { outputType: options.outputType } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.tool ? { tool: options.tool } : {}),
  });

  const model = options.model?.trim() ? options.model.trim() : plan.model;
  const chain = plan.providers.length > 0 ? plan.providers : [];
  const label = routingLabel(plan);

  // A model outside the configured providers (a pinned run model, or a tool's
  // declared model) is served by the local client; the map never invents keys.
  const local = model !== plan.model && chain.every((p) => p.model !== model);
  options.onRoute?.({ model, chain: chain.map((p) => p.model), providerId: chain[0]?.id });

  if (chain.length === 0 || local) {
    // No provider chain: keep the pre-N10 call exactly, including the model
    // preference order and the retry walk (`opts.model` -> `cfg.model` ->
    // `cfg.fallbackModel`). A mapped run never reaches this branch.
    return chatWithFallback({
      cfg: options.cfg,
      ollama: options.ollama,
      model,
      messages: options.messages,
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onToken ? { onToken: options.onToken } : {}),
      ...(options.onThinking ? { onThinking: options.onThinking } : {}),
      notify: options.notify,
      think: options.think,
      ...(options.cacheControl ? { cacheControl: true } : {}),
    });
  }

  log.info(`routing: ${label} via [${chain.map((p) => p.id).join(" > ")}]`);
  return chatWithFailover({
    providers: chain,
    chat: {
      messages: options.messages,
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
      temperature: options.temperature ?? options.cfg.agent.temperature,
      timeoutMs: options.timeoutMs ?? options.cfg.agent.requestTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onToken ? { onToken: options.onToken } : {}),
      ...(options.onThinking ? { onThinking: options.onThinking } : {}),
      think: options.think ?? false,
      ...(options.cacheControl ? { cacheControl: true } : {}),
    },
    store: options.store,
    env,
    createClient: options.createClient,
    onFailover: (line) => options.notify?.(line),
  });
}
