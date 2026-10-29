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
}

/**
 * Resolve and perform one model call honouring the routing map.
 *
 * Precedence: an explicit `model` > the per-tool entry > the effort entry > the
 * existing coding chain. When nothing matches a map, the call degrades to the
 * plain Ollama client, exactly as before N10.
 */
export async function chatWithRouting(options: RoutingCallOptions): Promise<ChatResult> {
  const env = options.env ?? process.env;
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
      notify: options.notify,
      think: options.think,
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
      think: options.think ?? false,
    },
    store: options.store,
    env,
    createClient: options.createClient,
    onFailover: (line) => options.notify?.(line),
  });
}
