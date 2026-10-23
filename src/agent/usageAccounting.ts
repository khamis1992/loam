/**
 * Token accounting helpers.
 *
 * Prompt-cache (KV cache) reads are reported by the cloud upstream only, so a
 * provider that omits the field must never have it turned into an explicit zero:
 * clients use `undefined` to mean "no cache telemetry", which is deliberately
 * distinct from "zero tokens reused" and is never classified as a miss.
 *
 * Every place that sums per-request usage must route through these helpers,
 * otherwise the cache counter silently disappears on verified runs (the
 * verifier, audit and orchestrator stages each sum usage again).
 */
import type { Usage } from "./events.js";

/** Accumulate provider cache telemetry, keeping an absent counter absent. */
export function addCachedTokens(target: Usage, readTokens: number | undefined): void {
  if (readTokens !== undefined) target.cachedTokens = (target.cachedTokens ?? 0) + readTokens;
}

/** Add every counter of `add` into `target`, including optional cache fields. */
export function addUsage(target: Usage, add: Usage): void {
  target.promptTokens += add.promptTokens;
  target.completionTokens += add.completionTokens;
  target.durationMs += add.durationMs;
  addCachedTokens(target, add.cachedTokens);
  if (add.cacheWriteTokens !== undefined) target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + add.cacheWriteTokens;
}

/** Non-mutating `addUsage`: returns a new total, used for checkpoint snapshots. */
export function sumUsage(base: Usage, add: Usage): Usage {
  const total: Usage = { ...base };
  addUsage(total, add);
  return total;
}
