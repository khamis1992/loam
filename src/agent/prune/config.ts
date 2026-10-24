import type { PruneConfig } from "./types.js";

/** Values used once a `compression.prune` block exists. A missing block resolves to "summary" instead. */
export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  strategy: "prune_then_summary",
  scorer: "heuristic",
  model: "",
  keepThreshold: 0.5,
  preserveRecent: 6,
  headChars: 300,
  minReduction: 0.15,
  maxStateTokens: 12000,
  maxRequestTokens: 16000,
  pinnedTools: [],
  sideEffectTools: [],
};

const STRATEGIES: readonly PruneConfig["strategy"][] = ["summary", "prune", "prune_then_summary"];
const SCORERS: readonly PruneConfig["scorer"][] = ["heuristic", "model"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = integer ? Math.floor(value) : value;
  return Math.min(max, Math.max(min, n));
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim().slice(0, 80);
    if (t) out.add(t);
    if (out.size >= 100) break;
  }
  return [...out];
}

/**
 * Resolve the `compression.prune` block. A missing (or non-object) block means
 * strategy "summary", so a stale config file keeps today's behaviour. Invalid
 * fields keep their defaults; the env overrides apply last and are ignored when
 * they do not name a known value.
 */
export function resolvePruneConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): PruneConfig {
  const d = DEFAULT_PRUNE_CONFIG;
  const b = isObj(raw) ? raw : undefined;
  const out: PruneConfig = b
    ? {
        strategy: pick(b.strategy, STRATEGIES, d.strategy),
        scorer: pick(b.scorer, SCORERS, d.scorer),
        model: typeof b.model === "string" ? b.model.trim().slice(0, 120) : d.model,
        keepThreshold: num(b.keepThreshold, d.keepThreshold, 0, 1, false),
        preserveRecent: num(b.preserveRecent, d.preserveRecent, 0, 200, true),
        headChars: num(b.headChars, d.headChars, 0, 5000, true),
        minReduction: num(b.minReduction, d.minReduction, 0, 0.9, false),
        maxStateTokens: num(b.maxStateTokens, d.maxStateTokens, 1000, 200_000, true),
        maxRequestTokens: num(b.maxRequestTokens, d.maxRequestTokens, 1000, 200_000, true),
        pinnedTools: names(b.pinnedTools),
        sideEffectTools: names(b.sideEffectTools),
      }
    : { ...d, strategy: "summary", pinnedTools: [], sideEffectTools: [] };

  out.strategy = pick(env.LOAM_PRUNE_STRATEGY?.trim(), STRATEGIES, out.strategy);
  out.scorer = pick(env.LOAM_PRUNE_SCORER?.trim(), SCORERS, out.scorer);
  return out;
}
