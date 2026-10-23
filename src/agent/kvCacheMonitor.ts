/**
 * Prompt-cache (KV cache) accounting and cold-cache warning.
 *
 * Ports jcode's daemon-side `kv_cache_monitor.rs`: parse each provider's usage
 * response into a normalized `{promptTokens, cachedTokens}` pair, then classify
 * a cache miss when a meaningful part of the previously reusable prefix was not
 * read back. Runs inside the agent so every client receives the same
 * classified event.
 *
 * Flow per provider request:
 * 1. `beginRequest(route, signature)` with the prompt-shape signature just
 *    before the request is sent.
 * 2. `finishRequest(reusableCacheTokens, readTokens)` with the provider-reported
 *    usage once the stream completes. Returns a `KvCacheMiss` when a meaningful
 *    part of the previously cached prefix was not read back.
 *
 * Adapted from jcode (MIT) src/kv_cache_monitor.rs
 */

/** Misses smaller than this are noise (provider cache block granularity). */
export const MIN_MISSED_TOKENS = 1_024;

/**
 * OpenAI reports cache reads in 128-token blocks and routinely leaves the last
 * ~1024 tokens of the previous request uncached, so a byte-identical append
 * still shows a 1024-1300 token shortfall. Across verified prefix-matching
 * continuations the shortfalls cluster just above 1024; treating them as
 * misses produced constant false alarms.
 */
export const OPENAI_MIN_MISSED_TOKENS = 2_048;

/** Noise floor for a provider identity (`openai`, `openai-api`, `OpenAI`, ...). */
export function minMissedTokensForProvider(provider: string): number {
  return provider.trim().toLowerCase().startsWith("openai")
    ? OPENAI_MIN_MISSED_TOKENS
    : MIN_MISSED_TOKENS;
}

/** Whether a provider drops its prompt cache when the UTC date changes. */
export function providerRollsCacheDaily(provider: string): boolean {
  const id = provider.trim().toLowerCase();
  return id === "anthropic" || id === "claude";
}

/** UTC calendar day number for a timestamp (defaults to now). */
export function utcDayOf(time: number = Date.now()): number {
  const secs = Math.floor(time / 1_000);
  return secs >= 0 ? Math.floor(secs / 86_400) : -Math.floor(-secs / 86_400) - 1;
}

/** Normalized token accounting shared by every provider shape. */
export interface PromptUsage {
  /** Total prompt/input tokens the provider billed for this request. */
  promptTokens: number;
  /** Tokens the provider reported as served from its prompt cache. */
  cachedTokens: number;
  /** Tokens written into the cache on this request, when reported. */
  cacheWriteTokens?: number;
  /** Uncached (re-sent) input tokens, when the provider splits accounting. */
  uncachedTokens?: number;
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** OpenAI-compatible: `prompt_tokens` + `prompt_tokens_details.cached_tokens`
 *  (also older top-level `cached_tokens`). */
export function parseOpenAiUsage(raw: unknown): PromptUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const promptTokens = toCount(u.prompt_tokens);
  const cachedTokens = Math.min(toCount(details.cached_tokens) || toCount(u.cached_tokens), promptTokens);
  return { promptTokens, cachedTokens };
}

/** Anthropic: `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`. */
export function parseAnthropicUsage(raw: unknown): PromptUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const uncached = toCount(u.input_tokens);
  const cachedTokens = toCount(u.cache_read_input_tokens);
  const cacheWriteTokens = toCount(u.cache_creation_input_tokens);
  return { promptTokens: uncached + cachedTokens + cacheWriteTokens, cachedTokens, cacheWriteTokens, uncachedTokens: uncached };
}

/** Ollama: no cache telemetry at all (prompt_eval_count only). */
export function parseOllamaUsage(raw: unknown): PromptUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  return { promptTokens: toCount(u.prompt_eval_count ?? u.prompt_tokens), cachedTokens: 0 };
}

/** Parse provider usage by provider id, falling back to the OpenAI shape. */
export function parseProviderUsage(provider: string, raw: unknown): PromptUsage {
  const id = provider.trim().toLowerCase();
  if (id.startsWith("anthropic") || id.startsWith("claude")) return parseAnthropicUsage(raw);
  if (id.startsWith("ollama")) return parseOllamaUsage(raw);
  return parseOpenAiUsage(raw);
}

/** Prompt-shape signature for one provider request. */
export interface RequestSignature {
  systemStaticHash: number;
  toolsHash: number;
  toolCount: number;
  messagesHash: number;
  messageHashes: number[];
  messageCount: number;
}

/** Whether `self` extends `previous` without modifying earlier messages. */
export function signatureExtends(self: RequestSignature, previous: RequestSignature): boolean {
  if (previous.messageCount > self.messageCount) return false;
  if (previous.messageHashes.length > 0 && self.messageHashes.length > 0) {
    return (
      self.messageHashes.length >= previous.messageHashes.length &&
      previous.messageHashes.every((hash, i) => self.messageHashes[i] === hash)
    );
  }
  return previous.messageCount === self.messageCount && previous.messagesHash === self.messagesHash;
}

/** Provider identity and cache retention for one request. */
export interface RequestRoute {
  provider: string;
  model: string;
  upstreamProvider?: string;
  /** OAuth account label bound to the request; caches are per account. */
  account?: string;
  /** Expected cache retention in seconds, when known. */
  cacheTtlSecs?: number;
  /** Whether `cacheTtlSecs` is only an estimate (never treat as hard expiry). */
  ttlIsEstimate?: boolean;
}

/** Why a request missed the cache. */
export type MissReason =
  | "provider_switch"
  | "account_switch"
  | "model_switch"
  | "upstream_switch"
  | "expired"
  | "daily_rollover"
  | "system_changed"
  | "tools_changed"
  | "prefix_changed"
  | "compaction"
  | "zero_read"
  | "low_read";

export const MISS_REASON_DETAIL: Record<MissReason, string> = {
  provider_switch: "provider changed",
  account_switch: "account changed; prompt caches are per account",
  model_switch: "model changed",
  upstream_switch: "upstream provider changed",
  expired: "cache expired",
  daily_rollover: "provider resets its prompt cache at 00:00 UTC; not avoidable by the harness",
  system_changed: "system prompt changed mid-session",
  tools_changed: "tool set changed mid-session",
  prefix_changed: "an earlier message was modified",
  compaction: "provider automatically compacted the context",
  zero_read: "provider reported no cache read",
  low_read: "provider read only part of the cache",
};

/** Harness-caused misses should essentially never happen; they indicate a bug. */
export function isHarnessCaused(reason: MissReason): boolean {
  return reason === "system_changed" || reason === "tools_changed" || reason === "prefix_changed";
}

/** A classified cache miss for one completed request. */
export interface KvCacheMiss {
  reason: MissReason;
  /** Tokens expected to be served from cache (previous reusable boundary). */
  expectedTokens: number;
  /** Tokens the provider reported as read from cache. */
  readTokens: number;
  /** Estimated shortfall against the previous reusable prefix. */
  missedTokens: number;
  /** Documented intentional invalidation that explains a harness-caused miss. */
  documentedCause?: string;
  /** Specific explanation (what changed, from what to what, timing). */
  detail: string;
}

/** Human-friendly token count: `987`, `4.12K`, `33.1K`, `336K`, `1.25M`. */
export function formatTokenCount(value: number): string {
  const trim = (text: string) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);
  const v = value as number;
  if (value >= 1_000_000) return `${trim((v / 1_000_000).toFixed(2))}M`;
  if (value >= 100_000) return `${Math.round(v / 1_000)}K`;
  if (value >= 10_000) return `${trim((v / 1_000).toFixed(1))}K`;
  if (value >= 1_000) return `${trim((v / 1_000).toFixed(2))}K`;
  return String(value);
}

/** Compact duration for diagnostics: `45s`, `6m 2s`, `1h 5m`. */
export function formatDurationSecs(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3_600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(secs / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function orUnknown(value: string | undefined): string {
  return value && value.length > 0 ? value : "default";
}

/** Inputs for a specific, human-readable explanation of one cache miss. */
export interface MissContext {
  oldProvider: string;
  newProvider: string;
  oldModel: string;
  newModel: string;
  oldAccount?: string;
  newAccount?: string;
  oldUpstream?: string;
  newUpstream?: string;
  /** Milliseconds between the previous request completing and this one starting. */
  idleMs?: number;
  ttlSecs?: number;
  ttlIsEstimate?: boolean;
  expectedTokens: number;
  readTokens: number;
  /** Index of the first previously sent message that changed, when known. */
  firstChangedMessage?: number;
}

/** Specific explanation for a classified miss. */
export function describeMiss(reason: MissReason, ctx: MissContext): string {
  const prefix = formatTokenCount(ctx.expectedTokens);
  const read = formatTokenCount(ctx.readTokens);
  switch (reason) {
    case "provider_switch":
      return `provider switched ${ctx.oldProvider} -> ${ctx.newProvider}; caches are not shared across providers`;
    case "account_switch":
      return `account switched ${orUnknown(ctx.oldAccount)} -> ${orUnknown(ctx.newAccount)} (e.g. failover after a rate limit); prompt caches are per account`;
    case "model_switch":
      return `model switched ${ctx.oldModel} -> ${ctx.newModel}; caches are per model`;
    case "upstream_switch":
      return `upstream route switched ${orUnknown(ctx.oldUpstream)} -> ${orUnknown(ctx.newUpstream)}; cache lives on the previous upstream`;
    case "expired":
      return ctx.idleMs !== undefined && ctx.ttlSecs !== undefined
        ? `idle ${formatDurationSecs(Math.floor(ctx.idleMs / 1_000))} exceeded the ${formatDurationSecs(ctx.ttlSecs)} cache TTL`
        : "cache retention elapsed";
    case "daily_rollover":
      return "provider resets its prompt cache at 00:00 UTC; not avoidable by the harness";
    case "system_changed":
      return "system prompt changed mid-session";
    case "tools_changed":
      return "tool set changed mid-session";
    case "prefix_changed":
      return ctx.firstChangedMessage !== undefined
        ? `earlier message #${ctx.firstChangedMessage} was modified, invalidating everything after it`
        : "an earlier message was modified";
    case "compaction":
      return "provider automatically compacted the context";
    case "zero_read":
    case "low_read": {
      const idle = ctx.idleMs !== undefined ? ` ${formatDurationSecs(Math.floor(ctx.idleMs / 1_000))} after the previous call` : "";
      const ttl = ctx.ttlSecs !== undefined
        ? `${ctx.ttlIsEstimate ? "estimated " : ""}TTL ${formatDurationSecs(ctx.ttlSecs)}`
        : "";
      const timing = [idle.trim(), ttl].filter(Boolean).join(", ");
      const same = ctx.oldAccount !== undefined && ctx.newAccount !== undefined ? "provider, model, account" : "provider, model";
      return `provider read ${read} of the ${prefix}-token prefix${timing ? ` ${timing}` : ""}; same ${same}, system prompt, tools and message prefix, so the provider evicted or rerouted the cache`;
    }
  }
}

/** One-line summary suitable for any client to display. */
export function missMessage(miss: KvCacheMiss): string {
  if (miss.reason === "compaction") {
    return `KV cache refresh [provider_auto_compaction]: provider compacted the context; rebuilding cache is expected (previous reusable prefix ~${formatTokenCount(miss.expectedTokens)} tokens, cache read ${formatTokenCount(miss.readTokens)}).`;
  }
  const tokens = formatTokenCount(miss.missedTokens);
  const detail = miss.detail.length > 0 ? miss.detail : MISS_REASON_DETAIL[miss.reason];
  if (miss.documentedCause) {
    return `KV cache refresh [${miss.documentedCause}]: ~${tokens} tokens resent (${detail}).`;
  }
  if (isHarnessCaused(miss.reason)) {
    return `KV cache miss [${miss.reason}]: ~${tokens} tokens resent (${detail}). This is likely a harness bug.`;
  }
  return `KV cache miss [${miss.reason}]: ~${tokens} tokens resent (${detail}).`;
}

interface Baseline {
  route: RequestRoute;
  signature: RequestSignature;
  reusableCacheTokens: number;
  completedAt: number;
  /** UTC day on which the baseline request was sent (its cache was written). */
  utcDay: number;
}

interface Pending {
  route: RequestRoute;
  signature: RequestSignature;
  providerCompaction: boolean;
  utcDay: number;
  startedAt: number;
}

/** Per-session miss detector. Reset whenever the provider-facing transcript is
 *  intentionally replaced (compaction, rewind, clear). */
export class KvCacheMonitor {
  private baseline: Baseline | undefined;
  private pending: Pending | undefined;

  constructor(
    private readonly now: () => number = () => Date.now(),
  ) {}

  reset(): void {
    this.baseline = undefined;
    this.pending = undefined;
  }

  beginRequest(route: RequestRoute, signature: RequestSignature): void {
    this.beginRequestOnDay(route, signature, utcDayOf(this.now()));
  }

  /** `beginRequest` with an explicit UTC day (for tests). */
  beginRequestOnDay(route: RequestRoute, signature: RequestSignature, utcDay: number): void {
    this.pending = { route, signature, providerCompaction: false, utcDay, startedAt: this.now() };
  }

  /** Mark compaction evidenced by the completed provider stream, not by a
   *  guessed token-count drop. Applies only to the current request. */
  noteProviderCompaction(): void {
    if (this.pending) this.pending.providerCompaction = true;
  }

  /** Record completed usage. `reusableCacheTokens` is the reusable cache
   *  boundary (read plus write, excluding uncached input for split accounting).
   *  `readTokens` is undefined when the provider did not report cache reads,
   *  which is never treated as a miss. */
  finishRequest(reusableCacheTokens: number, readTokens?: number): KvCacheMiss | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    this.pending = undefined;
    const miss = this.baseline ? classify(this.baseline, pending, readTokens) : undefined;
    if (reusableCacheTokens > 0) {
      this.baseline = {
        route: pending.route,
        signature: pending.signature,
        reusableCacheTokens,
        completedAt: this.now(),
        utcDay: pending.utcDay,
      };
    }
    return miss;
  }
}

function classify(baseline: Baseline, pending: Pending, readTokens: number | undefined): KvCacheMiss | undefined {
  if (readTokens === undefined) return undefined;
  const expected = baseline.reusableCacheTokens;
  if (expected === 0) return undefined;
  const missed = Math.max(0, expected - readTokens);
  if (missed < minMissedTokensForProvider(pending.route.provider)) return undefined;
  const reason = missReason(baseline, pending, readTokens);
  if (!reason) return undefined;
  const documentedCause =
    reason === "compaction" ? "provider_auto_compaction" : reason === "daily_rollover" ? "provider_daily_rollover" : undefined;
  const old = baseline.route;
  const next = pending.route;
  const firstChanged = pending.signature.messageHashes.findIndex((hash, i) => baseline.signature.messageHashes[i] !== hash);
  const detail = describeMiss(reason, {
    oldProvider: old.provider,
    newProvider: next.provider,
    oldModel: old.model,
    newModel: next.model,
    oldAccount: old.account,
    newAccount: next.account,
    oldUpstream: old.upstreamProvider,
    newUpstream: next.upstreamProvider,
    idleMs: Math.max(0, pending.startedAt - baseline.completedAt),
    ttlSecs: old.cacheTtlSecs,
    ttlIsEstimate: old.ttlIsEstimate,
    expectedTokens: expected,
    readTokens,
    firstChangedMessage: firstChanged >= 0 ? firstChanged : undefined,
  });
  return {
    reason,
    expectedTokens: expected,
    readTokens,
    missedTokens: missed,
    ...(documentedCause ? { documentedCause } : {}),
    detail,
  };
}

function missReason(baseline: Baseline, pending: Pending, read: number): MissReason | undefined {
  const old = baseline.route;
  const next = pending.route;
  if (old.provider !== next.provider) return "provider_switch";
  if (old.account !== undefined && next.account !== undefined && old.account !== next.account) return "account_switch";
  if (old.model !== next.model) return "model_switch";
  if (old.upstreamProvider !== undefined && next.upstreamProvider !== undefined && old.upstreamProvider !== next.upstreamProvider) return "upstream_switch";
  if (old.cacheTtlSecs !== undefined && old.ttlIsEstimate !== true && pending.startedAt - baseline.completedAt >= old.cacheTtlSecs * 1_000) return "expired";
  const prev = baseline.signature;
  const cur = pending.signature;
  if (prev.systemStaticHash !== cur.systemStaticHash) return "system_changed";
  if (prev.toolsHash !== cur.toolsHash || prev.toolCount !== cur.toolCount) return "tools_changed";
  // Route, expiry, system and tools changes remain independently actionable.
  // Native compaction explains a transcript-prefix or cache-read loss only.
  if (pending.providerCompaction) return "compaction";
  if (!signatureExtends(cur, prev)) return "prefix_changed";
  // Harness-caused changes above stay visible as bugs. Only an otherwise clean
  // append that straddles 00:00 UTC is attributed to the provider.
  if (baseline.utcDay !== pending.utcDay && providerRollsCacheDaily(next.provider)) return "daily_rollover";
  if (read === 0) return "zero_read";
  // The absolute tolerance was already checked against the reusable boundary.
  // A large warm prefix must not hide a real small cache loss.
  return "low_read";
}
