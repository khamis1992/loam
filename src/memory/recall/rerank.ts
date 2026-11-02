export interface ParsedScores {
  scores: number[];
}

/** Parse a rerank JSON payload. 1-based index lists are repaired into 0..1 ranks. */
export function parseRerankScores(raw: string, expected: number): number[] | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !("scores" in parsed)) return null;
  const scores = (parsed as { scores: unknown }).scores;
  if (!Array.isArray(scores) || scores.length !== expected) return null;
  if (!scores.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const nums = scores as number[];
  const looksRanked = nums.every((value) => Number.isInteger(value) && value >= 1 && value <= expected);
  if (looksRanked && new Set(nums).size === expected) {
    return nums.map((rank) => 1 - (rank - 1) / Math.max(1, expected));
  }
  if (nums.some((value) => value < 0 || value > 1)) return null;
  return nums;
}

export interface CircuitBreaker {
  allow(now: number): boolean;
  success(now: number, ms: number): void;
  failure(now: number): void;
  p50(): number | undefined;
  disabledUntil(): number;
}

export function createCircuitBreaker(opts: { failures: number; cooldownMs: number; autoOffP50Ms: number; autoOffSamples: number }): CircuitBreaker {
  let failures = 0;
  let openUntil = 0;
  const samples: number[] = [];
  return {
    allow(now) { return now >= openUntil; },
    success(now, ms) {
      failures = 0;
      samples.push(ms);
      if (samples.length > opts.autoOffSamples) samples.shift();
      if (samples.length >= opts.autoOffSamples) {
        const sorted = [...samples].sort((a, b) => a - b);
        const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
        if (mid > opts.autoOffP50Ms) openUntil = now + opts.cooldownMs;
      }
    },
    failure(now) {
      failures += 1;
      if (failures >= opts.failures) {
        openUntil = now + opts.cooldownMs;
        failures = 0;
      }
    },
    p50() {
      if (samples.length === 0) return undefined;
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },
    disabledUntil() { return openUntil; },
  };
}

export function blendScore(original: number, llm: number, blendOriginal: number): number {
  return blendOriginal * original + (1 - blendOriginal) * llm;
}
