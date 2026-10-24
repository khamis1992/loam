/**
 * Provider-neutral model access for the MiroFish seed pipeline.
 *
 * The pipeline only ever talks to the {@link ModelCaller} interface. The real
 * implementation ({@link createLoamModelCaller}) is wired to Loam's existing
 * provider/failover chain (`src/llm/failover.ts` and `src/agent/model.ts`);
 * tests inject a deterministic fake caller instead of touching a real API.
 *
 * This module also owns the robust JSON plumbing the pipeline relies on:
 * extraction from noisy model output, repair of common malformations, schema
 * validation and bounded retries.
 */
import type { Config } from "../../config.js";
import type { ChatMessage, OllamaClient } from "../../ollama.js";
import { chatWithFallback } from "../../agent/model.js";
import { chatWithFailover } from "../../llm/failover.js";

import type { ModelCaller, ModelRequest, ModelResponse, ModelRole } from "./types.js";

/**
 * The model boundary contract lives in `types.ts` so the seed / simulate / report
 * stages and their tests share one definition. Re-exported here for the callers
 * that historically imported it from this module.
 */
export type { ModelCaller, ModelRequest, ModelResponse, ModelCallInput, ModelCallOutput } from "./types.js";

/** Role attached to each call when the caller did not name one. */
export function roleOf(request: ModelRequest): ModelRole {
  return request.role ?? "simulate";
}

function toMessages(request: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (request.system && request.system.trim().length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push({ role: "user", content: request.prompt });
  return messages;
}

/**
 * Build a {@link ModelCaller} backed by Loam's provider/failover chain.
 * When `cfg.failover.providers` is configured the ordered provider chain is
 * used (with per-provider cooldowns); otherwise the preferred -> main ->
 * fallback model chain is used.
 */
export function createLoamModelCaller(
  cfg: Config,
  ollama: OllamaClient,
  opts: { onFailover?: (line: string) => void } = {},
): ModelCaller {
  const providers = cfg.failover?.providers ?? [];

  return {
    async chat(request) {
      const messages = toMessages(request);
      const temperature = request.temperature ?? cfg.agent.temperature;
      const timeoutMs = request.timeoutMs ?? cfg.agent.requestTimeoutMs;
      const base = {
        messages,
        temperature,
        timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.jsonSchema ? { format: request.jsonSchema } : {}),
      };

      if (providers.length > 0) {
        const result = await chatWithFailover({
          providers,
          chat: { ...base, model: cfg.model },
          onFailover: opts.onFailover,
        });
        return { content: result.content, model: result.model };
      }

      const result = await chatWithFallback({ cfg, ollama, ...base });
      return { content: result.content, model: result.model };
    },
  };
}

// ---------------------------------------------------------------------------
// JSON extraction / repair
// ---------------------------------------------------------------------------

/** Strip a leading/trailing ```json fence and surrounding prose. */
export function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|JSON)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function prevNonSpace(s: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const c = s[i];
    if (c && !/\s/.test(c)) return c;
  }
  return undefined;
}

function nextNonSpace(s: string, index: number): string | undefined {
  for (let i = index + 1; i < s.length; i++) {
    const c = s[i];
    if (c && !/\s/.test(c)) return c;
  }
  return undefined;
}

/**
 * Convert single-quoted JSON-ish strings to double quotes, but only when the
 * quote sits in a structural position (after `{ [ : ,` or before `} ] ,`).
 * Apostrophes inside double-quoted or unquoted words are left untouched.
 */
export function normalizeQuotes(s: string): string {
  let out = "";
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inDouble) {
      if (c === "\\") {
        out += c + (s[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      out += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      continue;
    }
    if (c === "'") {
      const prev = prevNonSpace(s, i);
      const next = nextNonSpace(s, i);
      const structural =
        prev === undefined || "{[:,".includes(prev) || next === undefined || "}],".includes(next);
      if (structural) {
        out += '"';
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Remove trailing commas before a closing brace/bracket. */
export function stripTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

/** Quote bare object keys: `{name: "x"}` -> `{"name": "x"}`. */
export function quoteBareKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_ -]*)(\s*:)/g, '$1"$2"$3');
}

/** Count unclosed `{`/`[`/`"` and append the missing closers. */
export function closeTruncated(s: string): string {
  let stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = s;
  if (inString) out += '"';
  while (stack.length > 0) {
    const open = stack.pop()!;
    out += open === "{" ? "}" : "]";
  }
  return out;
}

/** Apply every textual repair we know about, in order. */
export function repairJson(text: string): string {
  let s = stripCodeFence(text);
  s = normalizeQuotes(s);
  s = quoteBareKeys(s);
  s = stripTrailingCommas(s);
  s = closeTruncated(s);
  return s;
}

/** Find the first balanced `{...}` or `[...]` region in free text. */
export function extractJsonCandidate(text: string): string | null {
  const trimmed = stripCodeFence(text);
  const start = [...trimmed].findIndex((c) => c === "{" || c === "[");
  if (start < 0) return null;
  const open = trimmed[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return trimmed.slice(start);
}

/**
 * Parse model output that is expected to be JSON. Tries the raw text, then a
 * balanced candidate, then the repaired candidate. Returns `null` when nothing
 * parses.
 */
export function parseJsonLoose(text: string): unknown | null {
  if (!text || text.trim().length === 0) return null;
  const candidates = [stripCodeFence(text), extractJsonCandidate(text), repairJson(text)].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation helpers (no schema dependency; explicit and composable)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value.replace(/[,_\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asStringArray(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item);
    if (s && !out.includes(s) && out.length < max) out.push(s);
  }
  return out;
}

export function asNumberArray(value: unknown, max = 50): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = asNumber(item);
    if (n !== null && out.length < max) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structured call with retry
// ---------------------------------------------------------------------------

export interface AskJsonOptions<T> {
  system?: string;
  prompt: string;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  jsonSchema?: Record<string, unknown>;
  /** The pipeline stage making this call. Recorded on every request so the
   *  audit trail and the report's model attribution stay honest. */
  role?: ModelRole;
  /** Additional repair attempts after the first (default 2). */
  retries?: number;
  /** Validate + normalize the parsed JSON. Throw to trigger a retry. */
  validate: (value: unknown) => T;
}

/**
 * Ask the model for free text, with no JSON extraction or repair. Used by the
 * report stage, whose job is prose written from facts the pipeline computed; it
 * returns the raw {@link ModelResponse} so the caller can keep the provider's
 * model name for attribution.
 */
export async function askText(
  caller: ModelCaller,
  opts: {
    system?: string;
    prompt: string;
    role?: ModelRole;
    temperature?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ModelResponse> {
  return caller.chat({
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.system ? { system: opts.system } : {}),
    prompt: opts.prompt,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/**
 * Ask the model for JSON, then extract, repair, validate and (on failure)
 * retry with an explicit correction instruction. Throws only when every
 * attempt fails. The call carries `role` so every model call in the pipeline is
 * attributable to the stage that made it.
 */
export async function askJson<T>(caller: ModelCaller, opts: AskJsonOptions<T>): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 2);
  let lastError = "empty response";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const prompt =
      attempt === 0
        ? opts.prompt
        : `${opts.prompt}\n\nYour previous reply was not valid JSON: ${lastError}. Reply with only the corrected JSON object, no prose and no code fence.`;
    const response = await caller.chat({
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      prompt,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
    });
    try {
      const parsed = parseJsonLoose(response.content);
      return opts.validate(parsed);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`model returned invalid JSON after ${retries + 1} attempts: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Map over `items` with at most `limit` in flight. Order is preserved and the
 * first rejection stops the remaining work. Default limit 2 keeps RAM light.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const cap = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(cap, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Deterministic pseudo-random generator (mulberry32) for reproducible runs. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
