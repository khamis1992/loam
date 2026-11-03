import type { MemoryKind, RecallConfig } from "./types.js";

const kindDailyRate: Record<MemoryKind, number> = {
  preference: 0.995,
  fact: 0.99,
  event: 0.95,
  relationship: 0.998,
  insight: 0.97,
  project: 0.99,
  procedure: 0.995,
};

export function defaultRecallConfig(over: Partial<RecallConfig> = {}): RecallConfig {
  const base: RecallConfig = {
    weights: { keyword: 0.3, semantic: 0.7, recencyMax: 0.3, recencyHalfLifeH: 3 },
    rerank: { enabled: true, deadlineMs: 3500, blendOriginal: 0.4, minLlm: 0.15, maxCandidates: 20 },
    mmrLambda: 0.7,
    dedupe: { jaccard: 0.9, cosineWithJaccard: 0.85, cosineAlone: 0.95 },
    link: { updateCos: 0.7, extendCos: 0.5, topK: 5 },
    lsh: { tables: 12, bits: 6, componentsPerBit: 8, seed: 0x10a_a11ce, bruteForceBelow: 20_000 },
    decay: {
      kindDailyRate,
      weights: { age: 0.55, confFreq: 0.2, confRecency: 0.1, importance: 0.1, confidence: 0.05 },
      floor: 0.2,
      floorKinds: ["preference", "relationship"],
    },
    forget: { utilityThreshold: 0.1, minAgeDays: 14, hardDeleteBelow: 0.01, trashDays: 30 },
    gardener: {
      lightEveryMin: 10,
      deepEveryMin: 72,
      sleepEveryH: 20,
      quietHours: [2, 5],
      onlyWhenIdle: true,
      timeZone: "Asia/Riyadh",
    },
    models: { generator: "", embedder: "nomic-embed-text:latest" },
    injection: { maxTokens: 600, maxItems: 8, skipTrivial: true },
    coreLimits: { user: 2500, environment: 1500 },
  };
  return {
    ...base,
    ...over,
    weights: { ...base.weights, ...over.weights },
    rerank: { ...base.rerank, ...over.rerank },
    dedupe: { ...base.dedupe, ...over.dedupe },
    link: { ...base.link, ...over.link },
    lsh: { ...base.lsh, ...over.lsh },
    decay: { ...base.decay, ...over.decay, kindDailyRate: { ...base.decay.kindDailyRate, ...over.decay?.kindDailyRate }, weights: { ...base.decay.weights, ...over.decay?.weights } },
    forget: { ...base.forget, ...over.forget },
    gardener: { ...base.gardener, ...over.gardener },
    models: { ...base.models, ...over.models },
    injection: { ...base.injection, ...over.injection },
    coreLimits: { ...base.coreLimits, ...over.coreLimits },
  };
}

/** Days until a daily multiplier falls to one half. */
export function halfLifeDays(dailyRate: number): number {
  if (dailyRate <= 0 || dailyRate >= 1) return dailyRate >= 1 ? Number.POSITIVE_INFINITY : 0;
  return Math.log(0.5) / Math.log(dailyRate);
}
