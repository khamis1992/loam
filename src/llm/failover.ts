import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import {
  OllamaClient,
  ProviderHttpError,
  type ChatOptions,
  type ChatResult,
} from "../ollama.js";
import { log } from "../log.js";
import { CancelledError, isCancelledError } from "../server/runControl.js";

/** One entry in the ordered provider chain. `apiKeyEnv` is the *name* of the env
 *  var holding the key — never the key itself. */
export interface FailoverProvider {
  id: string;
  kind: "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  enabled: boolean;
}

/** Cooldown state for one (provider, model) pair. */
export interface CooldownEntry {
  expiresAt: number;
  backoffCount: number;
}

/** A provider as seen by the cooldown map. */
export type ProviderKey = string;

export function providerKey(p: FailoverProvider): ProviderKey {
  return `${p.id}:${p.model}`;
}

/** Minimal surface the failover loop needs from a provider client. */
export interface ProviderClient {
  chat(opts: ChatOptions): Promise<ChatResult>;
}

/** Persisted cooldown store. */
export interface CooldownStore {
  get(key: ProviderKey): CooldownEntry | undefined;
  set(key: ProviderKey, entry: CooldownEntry): void;
  entries(): Array<[ProviderKey, CooldownEntry]>;
  save(): void;
}

const AUTH_COOLDOWN_MS = 5 * 60_000;
const BILLING_COOLDOWN_MS = 60 * 60_000;
const TRANSIENT_COOLDOWN_MS = 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 4 * 60 * 60_000;
const ALL_COOLED_WAIT_LIMIT_MS = 60_000;
const MAX_PASSES = 16;

const COOLDOWN_FILE = path.join(DATA_DIR, "llm-cooldown.json");

export interface FailureClassification {
  /** Short human-readable reason used in failover log lines. */
  reason: string;
  /** Cooldown to arm in ms (0 = no cooldown). */
  cooldownMs: number;
  /** Skip this provider for the rest of the session without arming a cooldown. */
  skipSession: boolean;
}

export interface FailureInput {
  status?: number | null;
  message?: string;
  headers?: Headers | Record<string, string> | null;
  name?: string;
}

/** Extract an HTTP status from an error's structured status or its message. */
export function statusFrom(input: FailureInput): number | undefined {
  if (typeof input.status === "number" && Number.isFinite(input.status)) return input.status;
  const msg = input.message ?? "";
  const m = msg.match(/HTTP\s+(\d{3})/) ?? msg.match(/status(?:Code)?[=:\s]+(\d{3})/i);
  return m ? Number(m[1]) : undefined;
}

/** Parse a Retry-After / X-RateLimit-Reset style value: delta-seconds, an
 *  HTTP-date, or (for large integers) a Unix timestamp. Returns seconds. */
export function parseRetryAfterSeconds(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const raw = String(value).trim();
  if (raw.length === 0) return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 1e9) return Math.max(0, (n * 1000 - now) / 1000);
    return n;
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.max(0, (asDate - now) / 1000);
  return undefined;
}

/** Parse a human phrase like "try again in 1m30s" / "retry after 45 seconds".
 *  Sums every `<number><unit>` pair after the keyword, so compound durations work. */
export function parseHumanRetrySeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const keyword = value.match(/retry after|try again in|rate limited for|retry in|available in/i);
  if (!keyword || keyword.index === undefined) return undefined;
  const rest = value.slice(keyword.index + keyword[0].length);
  const unitSeconds: Record<string, number> = {
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  };
  const re = /(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)/gi;
  let total = 0;
  let matched = false;
  for (let m = re.exec(rest); m !== null; m = re.exec(rest)) {
    matched = true;
    total += Number(m[1]) * (unitSeconds[m[2]!.toLowerCase()] ?? 0);
  }
  if (matched) return total;
  const bare = rest.match(/^\s*(\d+)\b/);
  return bare ? Number(bare[1]) : undefined;
}

function headerValue(
  headers: Headers | Record<string, string> | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function rateLimitCooldown(input: FailureInput, backoffCount: number): number {
  const retrySeconds =
    parseRetryAfterSeconds(headerValue(input.headers, "retry-after")) ??
    parseRetryAfterSeconds(headerValue(input.headers, "x-ratelimit-reset")) ??
    parseRetryAfterSeconds(headerValue(input.headers, "ratelimit-reset")) ??
    parseHumanRetrySeconds(input.message ?? "");
  if (retrySeconds !== undefined) return Math.min(Math.max(0, retrySeconds) * 1000, BACKOFF_CAP_MS);
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, backoffCount), BACKOFF_CAP_MS);
}

/** Classify a provider failure into a cooldown / session-skip decision. */
export function classifyFailure(input: FailureInput, backoffCount = 0): FailureClassification {
  const status = statusFrom(input);
  const msg = input.message ?? "";

  if (status !== undefined) {
    if (status === 401 || status === 403) return { reason: `auth (${status})`, cooldownMs: AUTH_COOLDOWN_MS, skipSession: false };
    if (status === 429) return { reason: `rate limit (${status})`, cooldownMs: rateLimitCooldown(input, backoffCount), skipSession: false };
    if (status === 402) return { reason: `billing (${status})`, cooldownMs: BILLING_COOLDOWN_MS, skipSession: false };
    if (status === 400 || status === 404) return { reason: `request/model (${status})`, cooldownMs: 0, skipSession: true };
    if (status >= 500 && status < 600) return { reason: `transient (${status})`, cooldownMs: TRANSIENT_COOLDOWN_MS, skipSession: false };
    if (status >= 400 && status < 500) return { reason: `request (${status})`, cooldownMs: 0, skipSession: true };
    return { reason: `transient (${status})`, cooldownMs: TRANSIENT_COOLDOWN_MS, skipSession: false };
  }

  // No structured status: fall back to message heuristics.
  if (/\b40[13]\b/.test(msg) || /unauthorized|forbidden|invalid api key|authentication/i.test(msg)) {
    return { reason: "auth (message)", cooldownMs: AUTH_COOLDOWN_MS, skipSession: false };
  }
  if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg)) {
    return { reason: "rate limit (message)", cooldownMs: rateLimitCooldown(input, backoffCount), skipSession: false };
  }
  if (/\b402\b/.test(msg) || /billing|payment required|insufficient (credit|funds|quota)/i.test(msg)) {
    return { reason: "billing (message)", cooldownMs: BILLING_COOLDOWN_MS, skipSession: false };
  }
  if (/\b40[04]\b/.test(msg) || /context length|context_window|not found|invalid model|unknown model/i.test(msg)) {
    return { reason: "request/model (message)", cooldownMs: 0, skipSession: true };
  }
  return { reason: "transient (message)", cooldownMs: TRANSIENT_COOLDOWN_MS, skipSession: false };
}

/** JSON-file cooldown store with an atomic write (temp file + rename). */
export class JsonCooldownStore implements CooldownStore {
  private readonly map = new Map<ProviderKey, CooldownEntry>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Record<string, unknown>;
      const now = Date.now();
      for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object") continue;
        const entry = value as Partial<CooldownEntry>;
        if (typeof entry.expiresAt === "number" && entry.expiresAt > now) {
          this.map.set(key, { expiresAt: entry.expiresAt, backoffCount: Number(entry.backoffCount) || 0 });
        }
      }
    } catch {
      /* ignore missing or malformed state */
    }
  }

  get(key: ProviderKey): CooldownEntry | undefined {
    return this.map.get(key);
  }

  set(key: ProviderKey, entry: CooldownEntry): void {
    this.map.set(key, entry);
  }

  entries(): Array<[ProviderKey, CooldownEntry]> {
    return [...this.map.entries()];
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: Record<ProviderKey, CooldownEntry> = {};
      const now = Date.now();
      for (const [key, entry] of this.map.entries()) {
        if (entry.expiresAt > now) data[key] = entry;
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error(`[failover] failed to persist cooldowns: ${String(err)}`);
    }
  }
}

/** Build the client used to talk to one provider. */
export function createProviderClient(
  p: FailoverProvider,
  env: Record<string, string | undefined> = process.env,
): ProviderClient {
  if (p.kind === "ollama") return new OllamaClient(p.baseUrl);
  const apiKey = p.apiKeyEnv ? (env[p.apiKeyEnv] ?? "").trim() : "";
  return new OllamaClient(p.baseUrl, { baseUrl: p.baseUrl, apiKey: apiKey || undefined });
}

/** Model name to send for a provider (cloud providers need the `:cloud` marker). */
export function providerModel(p: FailoverProvider): string {
  if (p.kind === "ollama") return p.model;
  return p.model.endsWith(":cloud") ? p.model : `${p.model}:cloud`;
}

/** True when a cloud provider has a usable key configured. */
export function hasUsableKey(
  p: FailoverProvider,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (p.kind !== "openai-compatible") return true;
  const key = p.apiKeyEnv ? (env[p.apiKeyEnv] ?? "").trim() : "";
  return key.length > 0;
}

function toFailureInput(err: unknown): FailureInput {
  if (err instanceof ProviderHttpError) {
    return { status: err.status, message: err.message, headers: err.headers };
  }
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return { name: err.name, message: err.message, status: typeof status === "number" ? status : undefined };
  }
  return { message: String(err) };
}

const defaultNow = (): number => Date.now();
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Chat request for the failover loop. `model` is ignored: each provider supplies
 *  its own model via `providerModel`. */
export type FailoverChatRequest = Omit<ChatOptions, "model"> & { model?: string };

export interface ChatWithFailoverOptions {
  providers: FailoverProvider[];
  chat: FailoverChatRequest;
  store?: CooldownStore;
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createClient?: (provider: FailoverProvider) => ProviderClient;
  /** Called with each `failover: A -> B (reason)` line. */
  onFailover?: (line: string) => void;
}

function isAvailable(
  p: FailoverProvider,
  skipped: Set<ProviderKey>,
  store: CooldownStore,
  now: number,
): boolean {
  const key = providerKey(p);
  if (skipped.has(key)) return false;
  const entry = store.get(key);
  return !(entry && entry.expiresAt > now);
}

function soonestCooldown(
  providers: FailoverProvider[],
  skipped: Set<ProviderKey>,
  store: CooldownStore,
  now: number,
): number | undefined {
  let min: number | undefined;
  for (const p of providers) {
    if (skipped.has(providerKey(p))) continue;
    const entry = store.get(providerKey(p));
    if (entry && entry.expiresAt > now) min = min === undefined ? entry.expiresAt : Math.min(min, entry.expiresAt);
  }
  return min;
}

function aggregatedError(
  failures: Array<{ provider: FailoverProvider; message: string }>,
  providers: FailoverProvider[],
): Error {
  const detail =
    failures.length > 0
      ? failures.map((f) => `${f.provider.id}: ${f.message}`).join("; ")
      : providers.length > 0
        ? providers.map((p) => `${p.id}: cooled`).join("; ")
        : "no enabled providers";
  return new Error(`All providers failed or cooled: ${detail}`);
}

/** Try the provider chain in order, honoring per-provider cooldowns. Each call
 *  starts again at the top of the chain (cooled entries are skipped). */
export async function chatWithFailover(options: ChatWithFailoverOptions): Promise<ChatResult> {
  const store = options.store ?? new JsonCooldownStore(COOLDOWN_FILE);
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  const env = options.env ?? process.env;
  const createClient = options.createClient ?? ((p) => createProviderClient(p, env));
  const usable = options.providers.filter((p) => p.enabled && (p.kind !== "openai-compatible" || hasUsableKey(p, env)));
  const skipped = new Set<ProviderKey>();
  const failures: Array<{ provider: FailoverProvider; message: string }> = [];

  const nextAfter = (from: FailoverProvider, at: number): FailoverProvider | undefined => {
    const idx = usable.findIndex((p) => p === from);
    for (let i = idx + 1; i < usable.length; i++) {
      const candidate = usable[i]!;
      if (isAvailable(candidate, skipped, store, at)) return candidate;
    }
    return undefined;
  };

  const emit = (provider: FailoverProvider, next: FailoverProvider | undefined, reason: string): void => {
    const line = `failover: ${provider.id} -> ${next?.id ?? "none"} (${reason})`;
    log.warn(line);
    options.onFailover?.(line);
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const at = now();
    let tried = 0;

    for (const provider of usable) {
      const key = providerKey(provider);
      if (!isAvailable(provider, skipped, store, at)) continue;
      tried++;

      try {
        const client = createClient(provider);
        return await client.chat({ ...options.chat, model: providerModel(provider) });
      } catch (err) {
        if (options.chat.signal?.aborted || isCancelledError(err)) throw new CancelledError();
        const classification = classifyFailure(toFailureInput(err), store.get(key)?.backoffCount ?? 0);
        failures.push({ provider, message: err instanceof Error ? err.message : String(err) });

        if (classification.skipSession) {
          skipped.add(key);
          emit(provider, nextAfter(provider, at), classification.reason);
          continue;
        }
        if (classification.cooldownMs > 0) {
          store.set(key, {
            expiresAt: now() + classification.cooldownMs,
            backoffCount: (store.get(key)?.backoffCount ?? 0) + 1,
          });
          store.save();
        }
        emit(provider, nextAfter(provider, at), classification.reason);
      }
    }

    if (tried > 0) continue;

    const soonest = soonestCooldown(usable, skipped, store, now());
    if (soonest !== undefined && soonest - now() < ALL_COOLED_WAIT_LIMIT_MS) {
      await sleep(Math.max(0, soonest - now()));
      continue;
    }
    break;
  }

  throw aggregatedError(failures, options.providers);
}

/** OllamaClient-compatible facade that routes `chat` through the failover chain.
 *  Extends OllamaClient so it stays assignable everywhere an OllamaClient is
 *  expected; the non-chat helpers keep using the first enabled provider. */
export class FailoverClient extends OllamaClient {
  private readonly providers: FailoverProvider[];
  private readonly store: CooldownStore;

  constructor(providers: FailoverProvider[], opts: { store?: CooldownStore; cooldownFile?: string } = {}) {
    const primary = providers.find((p) => p.enabled);
    if (primary?.kind === "openai-compatible") {
      super(primary.baseUrl, { baseUrl: primary.baseUrl, apiKey: process.env[primary.apiKeyEnv] });
    } else if (primary) {
      super(primary.baseUrl);
    } else {
      super("http://127.0.0.1:11434");
    }
    this.providers = providers;
    this.store = opts.store ?? new JsonCooldownStore(opts.cooldownFile ?? COOLDOWN_FILE);
  }

  override async chat(options: ChatOptions): Promise<ChatResult> {
    return chatWithFailover({ providers: this.providers, chat: options, store: this.store });
  }
}

export function createFailoverClient(cfg: {
  failover?: { providers?: FailoverProvider[] };
}): FailoverClient | null {
  if (!cfg.failover?.providers?.length) return null;
  return new FailoverClient(cfg.failover.providers);
}
