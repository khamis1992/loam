/** Skill A/B statistics. Ideas from skillcheck (MIT): paired design, bootstrap CI, low-sample warning, token value.
 *  Difference: Loam resamples whole TASKS (cluster bootstrap), because trials of one task are correlated. */
export interface TrialPair { taskId: string; trial: number; baseline: number; withSkill: number; baselineTokens: number; withSkillTokens: number; }
export type AbVerdict = "HELPS" | "HURTS" | "NO_EFFECT" | "INCONCLUSIVE";
export interface AbResult {
  tasks: number; trials: number;
  meanBaseline: number; meanWithSkill: number;
  effectPp: number;                 // percentage points, with-skill minus baseline
  ci95: [number, number];           // percentage points
  verdict: AbVerdict; lowSample: boolean;
  tokenOverheadPct: number;         // (withSkill - baseline) / baseline * 100
  valuePer1kTokens: number | null;  // effectPp per extra 1k tokens; null when overhead <= 0
  perTask: Array<{ taskId: string; baseline: number; withSkill: number; effectPp: number }>;
  seed: number; iterations: number;
}

export const LOW_SAMPLE_TASKS = 5;
export const NO_EFFECT_BAND_PP = 2;   // |CI| fully inside ±2pp → NO_EFFECT

/** mulberry32: tiny deterministic PRNG so the same inputs always give the same CI. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function analyseAb(pairs: TrialPair[], opts: { iterations?: number; seed?: number } = {}): AbResult {
  const iterations = opts.iterations ?? 2000, seed = opts.seed ?? 1337;
  const byTask = new Map<string, TrialPair[]>();
  for (const p of pairs) { const l = byTask.get(p.taskId) ?? []; l.push(p); byTask.set(p.taskId, l); }
  const perTask = [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([taskId, ps]) => {
    const b = mean(ps.map((p) => p.baseline)), w = mean(ps.map((p) => p.withSkill));
    return { taskId, baseline: b, withSkill: w, effectPp: (w - b) * 100 };
  });
  const effects = perTask.map((t) => t.effectPp);
  const effectPp = mean(effects);
  const next = rng(seed);
  const boots: number[] = [];
  for (let i = 0; i < iterations && effects.length; i++) {
    let s = 0;
    for (let j = 0; j < effects.length; j++) s += effects[Math.floor(next() * effects.length)]!;
    boots.push(s / effects.length);
  }
  boots.sort((a, b) => a - b);
  const ci95: [number, number] = boots.length ? [quantile(boots, 0.025), quantile(boots, 0.975)] : [0, 0];
  const lowSample = perTask.length < LOW_SAMPLE_TASKS;
  const verdict: AbVerdict = ci95[0] > 0 ? "HELPS" : ci95[1] < 0 ? "HURTS"
    : ci95[0] >= -NO_EFFECT_BAND_PP && ci95[1] <= NO_EFFECT_BAND_PP ? "NO_EFFECT" : "INCONCLUSIVE";
  const bt = mean(pairs.map((p) => p.baselineTokens)), wt = mean(pairs.map((p) => p.withSkillTokens));
  const extra = wt - bt;
  return {
    tasks: perTask.length, trials: pairs.length,
    meanBaseline: mean(perTask.map((t) => t.baseline)), meanWithSkill: mean(perTask.map((t) => t.withSkill)),
    effectPp: Math.round(effectPp * 100) / 100, ci95: [Math.round(ci95[0] * 100) / 100, Math.round(ci95[1] * 100) / 100],
    verdict, lowSample,
    tokenOverheadPct: bt > 0 ? Math.round(((wt - bt) / bt) * 10000) / 100 : 0,
    valuePer1kTokens: extra > 0 ? Math.round((effectPp / (extra / 1000)) * 100) / 100 : null,
    perTask, seed, iterations,
  };
}
