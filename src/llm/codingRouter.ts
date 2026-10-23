/**
 * Coding-model routing (C17).
 *
 * For coding turns Loam prefers the strongest coder in the chain. The
 * preference list is *model ids* only — never API keys. It is resolved against
 * the existing failover providers (`src/llm/failover.ts`), which already own
 * cooldowns, key handling and the actual failover walk. This module only picks
 * the ordered subset of providers that may serve coding work and hands it to
 * `chatWithFailover`.
 *
 * Configuration (strongest wins):
 *   1. `LOAM_CODER_CHAIN` / `MANUS_LOCAL_CODER_CHAIN` (comma/space separated)
 *   2. `config.json` → `coding.chain` (array of model ids)
 *   3. the failover provider order itself
 */
import type { Config } from "../config.js";
import type { ChatOptions, ChatResult } from "../ollama.js";
import { log } from "../log.js";
import {
  chatWithFailover,
  createProviderClient,
  hasUsableKey,
  type CooldownStore,
  type FailoverProvider,
  type ProviderClient,
} from "./failover.js";

export type CoderChainSource = "env" | "config" | "failover" | "default";

export interface CoderChain {
  /** Ordered coder model ids, strongest first. Empty = derive from failover. */
  ids: string[];
  source: CoderChainSource;
}

/** Split a comma/space separated chain string into unique, trimmed ids. */
export function parseCoderChain(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(/[,\s]+/)) {
    const id = part.trim();
    if (id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Resolve the coder preference list from env, then config. */
export function coderChainIds(cfg: Config, env: Record<string, string | undefined> = process.env): CoderChain {
  const envIds = parseCoderChain(env.LOAM_CODER_CHAIN ?? env.MANUS_LOCAL_CODER_CHAIN);
  if (envIds.length > 0) return { ids: envIds, source: "env" };
  const configIds = Array.isArray(cfg.coding?.chain) ? cfg.coding.chain.filter((m) => typeof m === "string" && m.trim().length > 0) : [];
  if (configIds.length > 0) return { ids: configIds, source: "config" };
  const failoverIds = (cfg.failover?.providers ?? []).filter((p) => p.enabled).map((p) => p.model);
  if (failoverIds.length > 0) return { ids: failoverIds, source: "failover" };
  return { ids: cfg.model ? [cfg.model] : [], source: "default" };
}

/** Match a chain id to an enabled provider by exact model id, then provider id,
 *  then a model-id substring. Case-insensitive. */
export function matchCoderProvider(id: string, providers: FailoverProvider[]): FailoverProvider | undefined {
  const needle = id.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  return (
    providers.find((p) => p.model.toLowerCase() === needle || p.id.toLowerCase() === needle) ??
    providers.find((p) => p.model.toLowerCase().includes(needle))
  );
}

/** Enabled failover providers that carry a usable key. */
export function usableProviders(cfg: Config, env: Record<string, string | undefined> = process.env): FailoverProvider[] {
  return (cfg.failover?.providers ?? []).filter(
    (p) => p.enabled && (p.kind !== "openai-compatible" || hasUsableKey(p, env)),
  );
}

/** Ordered providers allowed to serve coding turns, strongest first.
 *  Chain entries are matched against the *enabled* provider list; a matched but
 *  keyless cloud provider is dropped, while unknown entries mean "use the whole
 *  available chain". */
export function codingProviders(cfg: Config, env: Record<string, string | undefined> = process.env): FailoverProvider[] {
  const chain = coderChainIds(cfg, env);
  const usable = usableProviders(cfg, env);
  if (chain.ids.length === 0) return usable;
  const enabled = (cfg.failover?.providers ?? []).filter((p) => p.enabled);
  const matched: FailoverProvider[] = [];
  for (const id of chain.ids) {
    const provider = matchCoderProvider(id, enabled);
    if (provider && !matched.includes(provider)) matched.push(provider);
  }
  if (matched.length === 0) return usable;
  return matched.filter((p) => usable.includes(p));
}

export interface CoderSelection {
  /** Coder id for a coding turn (`provider.model`); the request model adds the
   *  `:cloud` marker via `providerModel` when the call is made. */
  model: string;
  /** The provider that will serve it first, when known. */
  provider?: FailoverProvider;
  /** Ordered candidate providers. */
  providers: FailoverProvider[];
  chain: CoderChain;
}

/** Pick the strongest available coder and its ordered failover candidates.
 *  The reported model is the configured coder id (`provider.model`); the
 *  `:cloud` request marker is applied by `providerModel` when the call is made. */
export function selectCoder(cfg: Config, env: Record<string, string | undefined> = process.env): CoderSelection {
  const providers = codingProviders(cfg, env);
  const chain = coderChainIds(cfg, env);
  const provider = providers[0];
  return {
    model: provider ? provider.model : cfg.model,
    provider,
    providers,
    chain,
  };
}

/** Tool names that write to the workspace and therefore carry a coding model. */
const CODING_HINT = /\b(fix|bug|refactor|implement|patch|rename|delete|create|write|edit|modify|change|add|remove|build|compile|typecheck|lint|test|debug|migrate|commit|merge|branch|worktree|repo|function|class|module|import|export)\b/i;
const CODE_ARTIFACT = /\b(\.ts\b|\.tsx\b|\.js\b|\.jsx\b|\.py\b|\.go\b|\.rs\b|\.java\b|\.cs\b|src\/|lib\/|package\.json|tsconfig|README|git\b)/i;

/** Heuristic: does this turn ask for code/work changes rather than chat? */
export function isCodingTurn(prompt: string, history?: { role: string; content?: string }[]): boolean {
  const text = `${prompt ?? ""}\n${(history ?? []).slice(-3).map((m) => m.content ?? "").join("\n")}`;
  return CODING_HINT.test(text) || CODE_ARTIFACT.test(text);
}

export interface ChatWithCodingRouterOptions {
  cfg: Config;
  chat: ChatOptions;
  /** Client used when no failover provider is configured. */
  fallback: ProviderClient;
  env?: Record<string, string | undefined>;
  store?: CooldownStore;
  createClient?: (provider: FailoverProvider) => ProviderClient;
  /** Called once per call with the resolved coding model and chain. */
  onRoute?: (info: { model: string; chain: string[]; providerId?: string }) => void;
}

/** Chat through the coding subset of the failover chain. Falls back to the
 *  caller's client when no provider chain is configured. */
export async function chatWithCodingRouter(options: ChatWithCodingRouterOptions): Promise<ChatResult> {
  const env = options.env ?? process.env;
  const selection = selectCoder(options.cfg, env);
  options.onRoute?.({ model: selection.model, chain: selection.chain.ids, providerId: selection.provider?.id });

  if (selection.providers.length === 0) {
    return options.fallback.chat({ ...options.chat, model: selection.model });
  }

  log.info(
    `coding router: ${selection.model} via [${selection.providers.map((p) => p.id).join(" > ")}] (${selection.chain.source})`,
  );
  return chatWithFailover({
    providers: selection.providers,
    chat: options.chat,
    store: options.store,
    env,
    createClient: options.createClient ?? ((p) => createProviderClient(p, env)),
  });
}
